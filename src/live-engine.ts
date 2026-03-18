import fs from "fs";
import { Wallet } from "@ethersproject/wallet";
import axios from "axios";
import {
  ClobClient,
  type ApiKeyCreds,
  SignatureType,
  Side,
} from "@polymarket/clob-client";
import {
  PRIVATE_KEY,
  FUNDER_ADDRESS,
  CLOB_HOST,
  CHAIN_ID,
  SIGNATURE_TYPE,
  DATA_API,
  GAMMA_API,
  CLOB_API_KEY,
  CLOB_SECRET,
  CLOB_PASSPHRASE,
} from "./config";
import logger from "./logger";
import type {
  BotOrder,
  OrderResult,
  PaperPosition,
  SettlementResult,
  TradingEngine,
} from "./types";

const HTTP_TIMEOUT = 10_000;
const LIVE_PORTFOLIO_FILE = "live_portfolio.json";

interface LivePortfolio {
  positions: Record<string, PaperPosition>;
  totalPnL: number;
  settlementWins: number;
  settlementLosses: number;
  totalTrades: number;
}

function toSignatureType(n: number): SignatureType {
  if (n === 1) return SignatureType.POLY_PROXY;
  if (n === 2) return SignatureType.POLY_GNOSIS_SAFE;
  return SignatureType.EOA;
}

export class LiveTradingEngine implements TradingEngine {
  private client: ClobClient | null = null;
  private portfolio: LivePortfolio;

  constructor() {
    this.portfolio = this.load();
    logger.info(
      `Live engine local tracking — positions: ${Object.keys(this.portfolio.positions).length}, realized P&L: $${this.portfolio.totalPnL.toFixed(2)}`,
    );
  }

  private load(): LivePortfolio {
    try {
      if (fs.existsSync(LIVE_PORTFOLIO_FILE)) {
        const raw = fs.readFileSync(LIVE_PORTFOLIO_FILE, "utf-8");
        const data = JSON.parse(raw) as LivePortfolio;
        return {
          positions: data.positions ?? {},
          totalPnL: data.totalPnL ?? 0,
          settlementWins: data.settlementWins ?? 0,
          settlementLosses: data.settlementLosses ?? 0,
          totalTrades: data.totalTrades ?? 0,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to load live portfolio, starting fresh: ${msg}`);
    }
    return {
      positions: {},
      totalPnL: 0,
      settlementWins: 0,
      settlementLosses: 0,
      totalTrades: 0,
    };
  }

  private save(): void {
    try {
      fs.writeFileSync(
        LIVE_PORTFOLIO_FILE,
        JSON.stringify(this.portfolio, null, 2),
        "utf-8",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to save live portfolio: ${msg}`);
    }
  }

  async initialize(): Promise<void> {
    logger.info("Initializing live trading engine...");

    // Key stays in memory, never transmitted — used only for local EIP-712 signing
    const wallet = new Wallet(PRIVATE_KEY);
    logger.info(`Signer address: ${wallet.address}`);

    let creds: ApiKeyCreds;

    if (CLOB_API_KEY && CLOB_SECRET && CLOB_PASSPHRASE) {
      // Use pre-configured API credentials from .env
      creds = {
        key: CLOB_API_KEY,
        secret: CLOB_SECRET,
        passphrase: CLOB_PASSPHRASE,
      };
      logger.info("Using pre-configured API credentials");
    } else {
      // Derive API credentials via standard Polymarket flow
      const tempClient = new ClobClient(
        CLOB_HOST,
        CHAIN_ID,
        wallet,
        undefined,
        toSignatureType(SIGNATURE_TYPE),
        FUNDER_ADDRESS,
      );

      creds = await tempClient.createOrDeriveApiKey();
      logger.info("API credentials derived successfully");
    }

    this.client = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      wallet,
      creds,
      toSignatureType(SIGNATURE_TYPE),
      FUNDER_ADDRESS,
    );

    logger.info("Live trading engine initialized");
  }

  async execute(order: BotOrder): Promise<OrderResult> {
    if (!this.client) {
      return { success: false, error: "Live engine not initialized", paper: false };
    }

    try {
      // Fetch market metadata for tickSize and negRisk
      const marketResp = await axios.get(`${GAMMA_API}/markets`, {
        params: { clob_token_ids: order.tokenId },
        timeout: HTTP_TIMEOUT,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const markets: any[] = marketResp.data;
      const market = Array.isArray(markets) ? markets[0] : null;

      const tickSize = market?.minimum_tick_size ?? "0.01";
      const negRisk = market?.neg_risk ?? false;

      const side = order.side === "BUY" ? Side.BUY : Side.SELL;

      const result = await this.client.createAndPostOrder(
        {
          tokenID: order.tokenId,
          price: order.price,
          size: order.size,
          side,
        },
        { tickSize, negRisk },
      );

      const orderId =
        result?.orderID ?? result?.orderIds?.[0] ?? result?.id ?? "unknown";

      logger.info(
        `Live order placed: ${orderId} | ${order.side} ${order.size.toFixed(4)} @ $${order.price.toFixed(4)}`,
      );

      // Track position locally
      this.trackPosition(order);

      return {
        success: true,
        orderId,
        filledSize: order.size,
        filledPrice: order.price,
        paper: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Live order failed: ${msg}`);
      return { success: false, error: msg, paper: false };
    }
  }

  private trackPosition(order: BotOrder): void {
    const posKey = `${order.conditionId}:${order.outcome}`;

    if (order.side === "BUY") {
      const existing = this.portfolio.positions[posKey];
      if (existing) {
        const totalSize = existing.size + order.size;
        existing.avgPrice =
          (existing.avgPrice * existing.size + order.price * order.size) /
          totalSize;
        existing.size = totalSize;
      } else {
        this.portfolio.positions[posKey] = {
          conditionId: order.conditionId,
          tokenId: order.tokenId,
          side: "BUY",
          size: order.size,
          avgPrice: order.price,
          title: order.title,
          outcome: order.outcome,
        };
      }
    } else {
      const existing = this.portfolio.positions[posKey];
      if (existing) {
        const sellSize = Math.min(order.size, existing.size);
        const proceeds = sellSize * order.price;
        const cost = sellSize * existing.avgPrice;
        const pnl = proceeds - cost;
        this.portfolio.totalPnL += pnl;

        existing.size -= sellSize;
        if (existing.size < 0.0001) {
          delete this.portfolio.positions[posKey];
        }
      }
    }

    this.portfolio.totalTrades++;
    this.save();
  }

  getPositions(): Record<string, PaperPosition> {
    return this.portfolio.positions;
  }

  getRealizedPnL(): number {
    return this.portfolio.totalPnL;
  }

  getWinRate(): { wins: number; losses: number; rate: number } {
    const wins = this.portfolio.settlementWins;
    const losses = this.portfolio.settlementLosses;
    const total = wins + losses;
    return { wins, losses, rate: total > 0 ? (wins / total) * 100 : 0 };
  }

  async getBalance(): Promise<number> {
    try {
      const resp = await axios.get(`${DATA_API}/value`, {
        params: { user: FUNDER_ADDRESS },
        timeout: HTTP_TIMEOUT,
      });
      const data = resp.data;
      const val = parseFloat(
        Array.isArray(data) ? data[0]?.value : data?.value ?? data ?? "0",
      );
      return isNaN(val) ? 0 : val;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to get live balance: ${msg}`);
      return 0;
    }
  }

  async settleResolvedMarkets(): Promise<SettlementResult[]> {
    const positions = Object.entries(this.portfolio.positions);
    if (positions.length === 0) return [];

    let changed = false;
    const results: SettlementResult[] = [];

    for (const [posKey, pos] of positions) {
      try {
        const market = await this.fetchMarketData(pos.tokenId, pos.conditionId);

        if (!market) {
          try {
            await axios.get(`https://clob.polymarket.com/price`, {
              params: { token_id: pos.tokenId, side: "BUY" },
              timeout: HTTP_TIMEOUT,
            });
            continue;
          } catch (priceErr: any) {
            if (priceErr?.response?.status === 404) {
              const cost = pos.size * pos.avgPrice;
              this.portfolio.totalPnL -= cost;
              this.portfolio.settlementLosses++;
              results.push({ title: pos.title, outcome: pos.outcome, won: false, tokens: pos.size, payout: 0, pnl: -cost });
              delete this.portfolio.positions[posKey];
              changed = true;
              logger.info(
                `SETTLED (expired): ${pos.title} [${pos.outcome}] → UNKNOWN | ${pos.size.toFixed(2)} tokens | Payout: $0.00 | P&L: -$${cost.toFixed(2)}`,
              );
              continue;
            }
            continue;
          }
        }

        const isResolved =
          market.closed === true &&
          (market.ended === true ||
            market.umaResolutionStatus === "resolved" ||
            market.acceptingOrders === false);

        if (!isResolved) continue;

        const rawOutcomes = market.outcomes ?? [];
        const rawPrices = market.outcomePrices ?? [];
        const outcomes: string[] =
          typeof rawOutcomes === "string" ? JSON.parse(rawOutcomes) : rawOutcomes;
        const outcomePrices: string[] =
          typeof rawPrices === "string" ? JSON.parse(rawPrices) : rawPrices;

        const allSettled = outcomePrices.length > 0 && outcomePrices.every(
          (p: string) => {
            const n = parseFloat(p);
            return n <= 0.01 || n >= 0.99;
          },
        );
        if (!allSettled) continue;

        const outcomeIndex = outcomes.findIndex(
          (o: string) => o.toLowerCase() === pos.outcome.toLowerCase(),
        );
        if (outcomeIndex === -1) continue;

        const rawPrice = parseFloat(outcomePrices[outcomeIndex] ?? "0");
        const settlementPrice = rawPrice >= 0.99 ? 1 : 0;
        const isWinner = settlementPrice === 1;

        const cost = pos.size * pos.avgPrice;
        const payout = pos.size * settlementPrice;
        const pnl = payout - cost;

        // In live mode, payout happens on-chain automatically
        // We only track it locally for monitoring
        this.portfolio.totalPnL += pnl;
        if (isWinner) {
          this.portfolio.settlementWins++;
        } else {
          this.portfolio.settlementLosses++;
        }
        delete this.portfolio.positions[posKey];
        changed = true;

        results.push({ title: pos.title, outcome: pos.outcome, won: isWinner, tokens: pos.size, payout, pnl });
        const sign = pnl >= 0 ? "+" : "";
        logger.info(
          `SETTLED: ${pos.title} [${pos.outcome}] → ${isWinner ? "WON" : "LOST"} | ${pos.size.toFixed(2)} tokens | Payout: $${payout.toFixed(2)} | P&L: ${sign}$${pnl.toFixed(2)}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to check resolution for ${posKey}: ${msg}`);
      }
    }

    if (changed) this.save();
    return results;
  }

  private async fetchMarketData(tokenId: string, conditionId: string): Promise<any | null> {
    try {
      const resp = await axios.get(`${GAMMA_API}/markets`, {
        params: { clob_token_ids: tokenId },
        timeout: HTTP_TIMEOUT,
      });
      const data = resp.data;
      const market = Array.isArray(data) ? data[0] : data;
      if (market && market.conditionId) return market;
    } catch {}

    try {
      const resp = await axios.get(`${GAMMA_API}/markets`, {
        params: { condition_ids: conditionId },
        timeout: HTTP_TIMEOUT,
      });
      const data = resp.data;
      const market = Array.isArray(data) ? data[0] : data;
      if (market && market.conditionId) return market;
    } catch {}

    return null;
  }
}

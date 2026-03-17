import fs from "fs";
import axios from "axios";
import { PAPER_BALANCE, GAMMA_API } from "./config";
import logger from "./logger";
import type {
  BotOrder,
  OrderResult,
  PaperPortfolio,
  PaperPosition,
  PaperTradeRecord,
  SettlementResult,
  TradingEngine,
} from "./types";

const HTTP_TIMEOUT = 10_000;

const PORTFOLIO_FILE = "paper_portfolio.json";
const MAX_HISTORY = 500;

export class PaperTradingEngine implements TradingEngine {
  private portfolio: PaperPortfolio;

  constructor() {
    this.portfolio = this.load();
    logger.info(
      `Paper engine initialized — balance: $${this.portfolio.balance.toFixed(2)}, positions: ${Object.keys(this.portfolio.positions).length}`,
    );
  }

  private load(): PaperPortfolio {
    try {
      if (fs.existsSync(PORTFOLIO_FILE)) {
        const raw = fs.readFileSync(PORTFOLIO_FILE, "utf-8");
        const data = JSON.parse(raw) as PaperPortfolio;
        // Ensure all fields exist
        return {
          balance: data.balance ?? PAPER_BALANCE,
          positions: data.positions ?? {},
          totalTrades: data.totalTrades ?? 0,
          totalPnL: data.totalPnL ?? 0,
          settlementWins: data.settlementWins ?? 0,
          settlementLosses: data.settlementLosses ?? 0,
          tradeHistory: data.tradeHistory ?? [],
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to load paper portfolio, starting fresh: ${msg}`);
    }
    return {
      balance: PAPER_BALANCE,
      positions: {},
      totalTrades: 0,
      totalPnL: 0,
      settlementWins: 0,
      settlementLosses: 0,
      tradeHistory: [],
    };
  }

  private save(): void {
    try {
      fs.writeFileSync(
        PORTFOLIO_FILE,
        JSON.stringify(this.portfolio, null, 2),
        "utf-8",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to save paper portfolio: ${msg}`);
    }
  }

  async execute(order: BotOrder): Promise<OrderResult> {
    const posKey = `${order.conditionId}:${order.outcome}`;

    if (order.side === "BUY") {
      return this.executeBuy(order, posKey);
    } else {
      return this.executeSell(order, posKey);
    }
  }

  private executeBuy(order: BotOrder, posKey: string): OrderResult {
    if (order.usdcAmount > this.portfolio.balance) {
      return {
        success: false,
        error: `Insufficient paper balance: $${this.portfolio.balance.toFixed(2)} < $${order.usdcAmount.toFixed(2)}`,
        paper: true,
      };
    }

    this.portfolio.balance -= order.usdcAmount;

    const existing = this.portfolio.positions[posKey];
    if (existing) {
      // Weighted average price
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

    this.recordTrade(order);

    return {
      success: true,
      orderId: `paper-${Date.now()}`,
      filledSize: order.size,
      filledPrice: order.price,
      paper: true,
    };
  }

  private executeSell(order: BotOrder, posKey: string): OrderResult {
    const existing = this.portfolio.positions[posKey];
    if (!existing || existing.size <= 0) {
      return {
        success: false,
        error: `No paper position found for ${posKey}`,
        paper: true,
      };
    }

    const sellSize = Math.min(order.size, existing.size);
    const proceeds = sellSize * order.price;
    const cost = sellSize * existing.avgPrice;
    const pnl = proceeds - cost;

    this.portfolio.balance += proceeds;
    this.portfolio.totalPnL += pnl;

    existing.size -= sellSize;
    if (existing.size < 0.0001) {
      delete this.portfolio.positions[posKey];
    }

    this.recordTrade({ ...order, size: sellSize, usdcAmount: proceeds });

    return {
      success: true,
      orderId: `paper-${Date.now()}`,
      filledSize: sellSize,
      filledPrice: order.price,
      paper: true,
    };
  }

  private recordTrade(order: BotOrder): void {
    this.portfolio.totalTrades++;

    const record: PaperTradeRecord = {
      timestamp: new Date().toISOString(),
      conditionId: order.conditionId,
      tokenId: order.tokenId,
      side: order.side,
      size: order.size,
      price: order.price,
      usdcAmount: order.usdcAmount,
      title: order.title,
      outcome: order.outcome,
      balanceAfter: this.portfolio.balance,
    };

    this.portfolio.tradeHistory.push(record);
    if (this.portfolio.tradeHistory.length > MAX_HISTORY) {
      this.portfolio.tradeHistory = this.portfolio.tradeHistory.slice(-MAX_HISTORY);
    }

    this.save();
  }

  async getBalance(): Promise<number> {
    return this.portfolio.balance;
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

  async settleResolvedMarkets(): Promise<SettlementResult[]> {
    const positions = Object.entries(this.portfolio.positions);
    if (positions.length === 0) return [];

    let changed = false;
    const results: SettlementResult[] = [];

    for (const [posKey, pos] of positions) {
      try {
        // Try to find market data via multiple query methods
        const market = await this.fetchMarketData(pos.tokenId, pos.conditionId);

        if (!market) {
          // No market data at all — check if CLOB price also 404s
          // If both are gone, market is dead — settle as loss
          try {
            await axios.get(`https://clob.polymarket.com/price`, {
              params: { token_id: pos.tokenId, side: "BUY" },
              timeout: HTTP_TIMEOUT,
            });
            // Price still available — market is active, skip
            continue;
          } catch (priceErr: any) {
            if (priceErr?.response?.status === 404) {
              // Both Gamma and CLOB are gone — market is dead
              const cost = pos.size * pos.avgPrice;
              this.portfolio.totalPnL -= cost;
              this.portfolio.settlementLosses++;
              delete this.portfolio.positions[posKey];
              changed = true;
              results.push({ title: pos.title, outcome: pos.outcome, won: false, tokens: pos.size, payout: 0, pnl: -cost });
              logger.info(
                `SETTLED (expired): ${pos.title} [${pos.outcome}] → UNKNOWN | ${pos.size.toFixed(2)} tokens | Payout: $0.00 | P&L: -$${cost.toFixed(2)}`,
              );
              continue;
            }
            continue;
          }
        }

        // Check if market is resolved
        const isResolved =
          market.closed === true &&
          (market.ended === true ||
            market.umaResolutionStatus === "resolved" ||
            market.acceptingOrders === false);

        if (!isResolved) continue;

        // Get outcome prices — API may return arrays or JSON strings
        const rawOutcomes = market.outcomes ?? [];
        const rawPrices = market.outcomePrices ?? [];
        const outcomes: string[] =
          typeof rawOutcomes === "string" ? JSON.parse(rawOutcomes) : rawOutcomes;
        const outcomePrices: string[] =
          typeof rawPrices === "string" ? JSON.parse(rawPrices) : rawPrices;

        // Verify prices are final (each is 0 or 1)
        const allSettled = outcomePrices.length > 0 && outcomePrices.every(
          (p: string) => {
            const n = parseFloat(p);
            return n <= 0.01 || n >= 0.99;
          },
        );
        if (!allSettled) continue;

        // Find our outcome
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

        this.portfolio.balance += payout;
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
    // Try clob_token_ids first (works for recent markets)
    try {
      const resp = await axios.get(`${GAMMA_API}/markets`, {
        params: { clob_token_ids: tokenId },
        timeout: HTTP_TIMEOUT,
      });
      const data = resp.data;
      const market = Array.isArray(data) ? data[0] : data;
      if (market && market.conditionId) return market;
    } catch {}

    // Try condition_ids (works for older markets)
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

  printSummary(): void {
    logger.info("=== PAPER PORTFOLIO SUMMARY ===");
    logger.info(`Balance: $${this.portfolio.balance.toFixed(2)}`);
    logger.info(`Total trades: ${this.portfolio.totalTrades}`);
    logger.info(`Total P&L: $${this.portfolio.totalPnL.toFixed(2)}`);

    const positions = Object.entries(this.portfolio.positions);
    if (positions.length === 0) {
      logger.info("No open positions");
    } else {
      logger.info(`Open positions (${positions.length}):`);
      for (const [key, pos] of positions) {
        logger.info(
          `  ${key}: ${pos.size.toFixed(4)} @ $${pos.avgPrice.toFixed(4)} | ${pos.title} [${pos.outcome}]`,
        );
      }
    }
    logger.info("================================");
  }
}

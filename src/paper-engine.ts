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

  async settleResolvedMarkets(): Promise<void> {
    const positions = Object.entries(this.portfolio.positions);
    if (positions.length === 0) return;

    for (const [posKey, pos] of positions) {
      try {
        const resp = await axios.get(`${GAMMA_API}/markets`, {
          params: { condition_ids: pos.conditionId },
          timeout: HTTP_TIMEOUT,
        });

        const data = resp.data;
        const market = Array.isArray(data) ? data[0] : data;
        if (!market) continue;

        // Check if market is resolved
        // Sports markets use "ended", crypto markets use "closed" + "umaResolutionStatus"
        const isResolved =
          (market.closed && market.ended) ||
          (market.closed && market.umaResolutionStatus === "resolved") ||
          (market.closed && !market.acceptingOrders && market.outcomePrices);

        if (!isResolved) {
          logger.info(
            `Settlement skip ${posKey}: closed=${market.closed} ended=${market.ended} umaStatus=${market.umaResolutionStatus} acceptingOrders=${market.acceptingOrders}`,
          );
          continue;
        }

        // Verify outcomePrices are final (0 or 1, not mid-market)
        const prices: string[] = market.outcomePrices ?? [];
        const allSettled = prices.length > 0 && prices.every(
          (p: string) => parseFloat(p) === 0 || parseFloat(p) === 1,
        );
        if (!allSettled) {
          logger.info(
            `Settlement skip ${posKey}: outcomePrices not final: ${JSON.stringify(prices)}`,
          );
          continue;
        }

        // Match outcome to get payout price
        // outcomes: ["Panthers", "Kraken"], outcomePrices: ["0", "1"]
        const outcomes: string[] = market.outcomes ?? [];
        const outcomePrices: string[] = market.outcomePrices ?? [];
        const outcomeIndex = outcomes.findIndex(
          (o: string) => o.toLowerCase() === pos.outcome.toLowerCase(),
        );
        if (outcomeIndex === -1) continue;

        const settlementPrice = parseFloat(outcomePrices[outcomeIndex] ?? "0");
        const isWinner = settlementPrice > 0.5;

        const cost = pos.size * pos.avgPrice;
        const payout = pos.size * settlementPrice;
        const pnl = payout - cost;

        this.portfolio.balance += payout;
        this.portfolio.totalPnL += pnl;
        delete this.portfolio.positions[posKey];

        const sign = pnl >= 0 ? "+" : "";
        logger.info(
          `SETTLED: ${pos.title} [${pos.outcome}] → ${isWinner ? "WON" : "LOST"} | ${pos.size.toFixed(2)} tokens | Payout: $${payout.toFixed(2)} | P&L: ${sign}$${pnl.toFixed(2)}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.debug(`Failed to check resolution for ${posKey}: ${msg}`);
      }
    }

    this.save();
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

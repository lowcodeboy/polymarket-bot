import fs from "fs";
import { TRACKED_WALLETS, PAPER_TRADING, POLL_INTERVAL, PAPER_BALANCE } from "./config";
import logger from "./logger";
import { TraderTracker } from "./tracker";
import { PositionSizer } from "./sizer";
import { PaperTradingEngine } from "./paper-engine";
import { LiveTradingEngine } from "./live-engine";
import type { TradingEngine } from "./types";

const MAX_PROCESSED = 10_000;
const PROCESSED_FILE = "processed_hashes.json";

export class CopyTradingBot {
  private tracker: TraderTracker;
  private sizer: PositionSizer;
  private engine: TradingEngine;
  private paperEngine: PaperTradingEngine | null = null;
  private processed: Set<string>;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.tracker = new TraderTracker(TRACKED_WALLETS);
    this.sizer = new PositionSizer();
    this.processed = this.loadProcessed();

    if (PAPER_TRADING) {
      const pe = new PaperTradingEngine();
      this.paperEngine = pe;
      this.engine = pe;
    } else {
      this.engine = new LiveTradingEngine();
    }
  }

  async start(): Promise<void> {
    this.printBanner();

    if (!PAPER_TRADING && this.engine instanceof LiveTradingEngine) {
      await this.engine.initialize();
    }

    this.running = true;
    logger.info("Bot started — entering main loop");
    await this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info("Bot stopping...");
    if (this.paperEngine) {
      this.paperEngine.printSummary();
    }
    logger.info("Bot stopped");
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Tick error: ${msg}`);
      }

      if (!this.running) break;
      await this.sleep(POLL_INTERVAL * 1000);
    }
  }

  private async tick(): Promise<void> {
    const trades = await this.tracker.pollNewTrades();
    let hasNewTrades = false;

    for (const trade of trades) {
      if (!trade.transactionHash || this.processed.has(trade.transactionHash)) {
        continue;
      }

      hasNewTrades = true;
      this.addProcessed(trade.transactionHash);

      logger.info(
        `Detected: ${trade.wallet.slice(0, 8)}... ${trade.side} ${trade.size.toFixed(4)} @ $${trade.price.toFixed(4)} | ${trade.title} [${trade.outcome}]`,
      );

      try {
        const balance = await this.engine.getBalance();
        const traderValue = await this.tracker.getPortfolioValue(trade.wallet);

        const order = this.sizer.calculate(trade, balance, traderValue);
        if (!order) {
          logger.debug("Order skipped by sizer");
          continue;
        }

        // Check current price and slippage
        const currentPrice = await this.tracker.getTokenPrice(
          trade.tokenId,
          trade.side,
        );

        if (currentPrice !== null) {
          if (!this.sizer.isWithinSlippage(order.price, currentPrice)) {
            logger.warn(
              `Slippage too high: order $${order.price.toFixed(4)} vs current $${currentPrice.toFixed(4)} — skipping`,
            );
            continue;
          }
          // Use current price for better execution
          order.price = currentPrice;
          order.size = order.usdcAmount / currentPrice;
        }

        const result = await this.engine.execute(order);

        if (result.success) {
          logger.info(
            `Executed: ${result.paper ? "PAPER" : "LIVE"} ${order.side} ${result.filledSize?.toFixed(4)} @ $${result.filledPrice?.toFixed(4)} | ${order.title} [${order.outcome}] (order: ${result.orderId})`,
          );
        } else {
          logger.error(`Execution failed: ${result.error}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Error processing trade ${trade.transactionHash}: ${msg}`);
      }
    }

    if (hasNewTrades) {
      if (this.paperEngine) {
        await this.paperEngine.settleResolvedMarkets();
      }
      await this.printPnLSnapshot();
    }
  }

  private async printPnLSnapshot(): Promise<void> {
    try {
      const positions = this.engine.getPositions();
      const entries = Object.entries(positions);
      if (entries.length === 0) return;

      const balance = await this.engine.getBalance();
      let totalInvested = 0;
      let totalCurrentValue = 0;
      let totalUnrealizedPnL = 0;

      logger.info("--- P&L SNAPSHOT ---");

      for (const [key, pos] of entries) {
        const currentPrice = await this.tracker.getTokenPrice(pos.tokenId, "BUY");
        const invested = pos.size * pos.avgPrice;
        totalInvested += invested;

        if (currentPrice !== null) {
          const currentValue = pos.size * currentPrice;
          const unrealizedPnL = currentValue - invested;
          const pnlPct = invested > 0 ? (unrealizedPnL / invested) * 100 : 0;
          totalCurrentValue += currentValue;
          totalUnrealizedPnL += unrealizedPnL;

          const sign = unrealizedPnL >= 0 ? "+" : "";
          logger.info(
            `  ${pos.title} [${pos.outcome}] | ${pos.size.toFixed(2)} @ $${pos.avgPrice.toFixed(4)} -> $${currentPrice.toFixed(4)} | ${sign}$${unrealizedPnL.toFixed(2)} (${sign}${pnlPct.toFixed(1)}%)`,
          );
        } else {
          totalCurrentValue += invested;
          logger.info(
            `  ${pos.title} [${pos.outcome}] | ${pos.size.toFixed(2)} @ $${pos.avgPrice.toFixed(4)} -> price unavailable`,
          );
        }
      }

      const totalPortfolio = balance + totalCurrentValue;
      const overallPnL = totalPortfolio - PAPER_BALANCE;
      const sign = totalUnrealizedPnL >= 0 ? "+" : "";
      const overallSign = overallPnL >= 0 ? "+" : "";

      logger.info(
        `  Cash: $${balance.toFixed(2)} | Invested: $${totalInvested.toFixed(2)} | Unrealized P&L: ${sign}$${totalUnrealizedPnL.toFixed(2)} | Portfolio: $${totalPortfolio.toFixed(2)} (${overallSign}${overallPnL.toFixed(2)})`,
      );
      logger.info("--------------------");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to print P&L snapshot: ${msg}`);
    }
  }

  private addProcessed(hash: string): void {
    this.processed.add(hash);
    if (this.processed.size > MAX_PROCESSED) {
      const toRemove = this.processed.size - MAX_PROCESSED;
      let removed = 0;
      for (const h of this.processed) {
        if (removed >= toRemove) break;
        this.processed.delete(h);
        removed++;
      }
    }
    this.saveProcessed();
  }

  private loadProcessed(): Set<string> {
    try {
      if (fs.existsSync(PROCESSED_FILE)) {
        const raw = fs.readFileSync(PROCESSED_FILE, "utf-8");
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          logger.info(`Loaded ${arr.length} processed transaction hashes`);
          return new Set(arr as string[]);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to load processed hashes: ${msg}`);
    }
    return new Set();
  }

  private saveProcessed(): void {
    try {
      const arr = Array.from(this.processed);
      fs.writeFileSync(PROCESSED_FILE, JSON.stringify(arr), "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to save processed hashes: ${msg}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = setTimeout(resolve, ms);
    });
  }

  private printBanner(): void {
    const mode = PAPER_TRADING ? "PAPER TRADING" : "LIVE TRADING";
    const banner = `
╔══════════════════════════════════════════════════╗
║           POLYMARKET COPY TRADING BOT            ║
╠══════════════════════════════════════════════════╣
║  Mode: ${mode.padEnd(41)}║
║  Tracked wallets: ${String(TRACKED_WALLETS.length).padEnd(30)}║
║  Poll interval: ${String(POLL_INTERVAL).padEnd(32)}s║
╠══════════════════════════════════════════════════╣
║  Security:                                       ║
║  ✓ Private key NEVER sent over the network       ║
║  ✓ Only official Polymarket endpoints             ║
║  ✓ No external databases                          ║
║  ✓ No telemetry or analytics                      ║
╚══════════════════════════════════════════════════╝`;
    console.log(banner);
  }
}

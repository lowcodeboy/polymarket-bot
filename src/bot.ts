import fs from "fs";
import axios from "axios";
import { TRACKED_WALLETS, PAPER_TRADING, POLL_INTERVAL, PAPER_BALANCE } from "./config";
import logger from "./logger";
import { TraderTracker } from "./tracker";
import { PositionSizer } from "./sizer";
import { PaperTradingEngine } from "./paper-engine";
import { LiveTradingEngine } from "./live-engine";
import { StatsCollector } from "./stats";
import { TelegramNotifier } from "./telegram";
import { SignalDetector } from "./signal-detector";
import type { TradingEngine, DetectedTrade } from "./types";
import type { StatsPosition } from "./stats";

const MAX_PROCESSED = 10_000;
const PROCESSED_FILE = "processed_hashes.json";
const POLL_MS = POLL_INTERVAL * 1000;
const SNAPSHOT_INTERVAL_MS = 30_000; // P&L snapshot every 30 seconds

export class CopyTradingBot {
  private tracker: TraderTracker;
  private sizer: PositionSizer;
  private engine: TradingEngine;
  private paperEngine: PaperTradingEngine | null = null;
  private processed: Set<string>;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private statsCollector: StatsCollector;
  private telegram: TelegramNotifier;
  private signalDetector: SignalDetector;
  private skippedMinSize: Array<{ title: string; outcome: string; side: string; calculatedSize: number; price: number; timestamp: string }> = [];
  private lastSnapshotAt = 0;
  private lastTraderValue = 0;

  constructor() {
    this.tracker = new TraderTracker(TRACKED_WALLETS);
    this.sizer = new PositionSizer();
    this.processed = this.loadProcessed();
    this.statsCollector = new StatsCollector(PAPER_BALANCE);
    this.telegram = new TelegramNotifier();
    this.telegram.setStatsCollector(this.statsCollector);
    this.signalDetector = new SignalDetector(this.statsCollector, this.telegram);

    if (PAPER_TRADING) {
      const pe = new PaperTradingEngine();
      this.paperEngine = pe;
      this.engine = pe;
    } else {
      this.engine = new LiveTradingEngine();
    }
  }

  getStatsCollector(): StatsCollector {
    return this.statsCollector;
  }

  getTelegram(): TelegramNotifier {
    return this.telegram;
  }

  async start(): Promise<void> {
    this.printBanner();

    if (!PAPER_TRADING && this.engine instanceof LiveTradingEngine) {
      await this.engine.initialize();
    }

    this.running = true;
    logger.info("Bot started — entering main loop");
    await this.telegram.notifyStartup();
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
    this.telegram.notifyShutdown();
    this.telegram.stop();
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
      await this.sleep(POLL_MS);
    }
  }

  private async tick(): Promise<void> {
    // Poll and process trades immediately (no buffer — /trades API pre-aggregates fills)
    const rawTrades = await this.tracker.pollNewTrades();
    const newTrades: DetectedTrade[] = [];

    for (const trade of rawTrades) {
      if (!trade.transactionHash || this.processed.has(trade.transactionHash)) {
        continue;
      }
      this.addProcessed(trade.transactionHash);
      newTrades.push(trade);
    }

    if (newTrades.length > 0) {
      await this.processTrades(newTrades);
    }

    // Check settlements
    const settlements = await this.engine.settleResolvedMarkets();
    for (const s of settlements) {
      await this.telegram.notifySettlement(s.title, s.outcome, s.won, s.tokens, s.payout, s.pnl);
    }

    // Snapshot every 30 seconds
    const now = Date.now();
    if (now - this.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
      await this.printPnLSnapshot();
      this.lastSnapshotAt = now;

      // Check for go-live signal after snapshot (paper mode only)
      if (PAPER_TRADING) {
        await this.signalDetector.check(this.lastTraderValue).catch(() => {});
      }
    }
  }

  private async processTrades(trades: DetectedTrade[]): Promise<void> {
    for (const trade of trades) {
      logger.info(
        `Detected: ${trade.wallet.slice(0, 8)}... ${trade.side} ${trade.size.toFixed(4)} @ $${trade.price.toFixed(4)} | ${trade.title} [${trade.outcome}]`,
      );

      try {
        // Skip partial fills — trader's fill fragments below 5 tokens are not real orders
        if (trade.size < 5) {
          logger.debug(
            `Skipping partial fill: traderTokens=${trade.size.toFixed(2)} < 5 | ${trade.title} [${trade.outcome}]`,
          );
          continue;
        }

        const balance = await this.engine.getBalance();
        const traderValue = await this.tracker.getPortfolioValue(trade.wallet);
        this.lastTraderValue = traderValue;
        logger.info(`Sizer inputs: myBalance=$${balance.toFixed(2)} | traderValue=$${traderValue.toFixed(2)} | tradeUSDC=$${trade.usdcSize.toFixed(2)} | traderTokens=${trade.size.toFixed(2)} | traderPrice=$${trade.price.toFixed(4)}`);
        const positions = this.engine.getPositions();

        let order = this.sizer.calculate(trade, balance, traderValue, positions);
        if (!order) {
          logger.debug("Order skipped by sizer");
          continue;
        }

        // If sized order is below 5 tokens, fallback to trader's exact size (guaranteed >= 5)
        if (order.size < 5) {
          const exactUsdc = trade.size * trade.price;
          if (trade.side === "BUY" && exactUsdc > balance) {
            logger.warn(
              `Min token fallback: need $${exactUsdc.toFixed(2)} but only $${balance.toFixed(2)} — skipping | ${order.title} [${order.outcome}]`,
            );
            this.skippedMinSize.push({
              title: order.title,
              outcome: order.outcome,
              side: order.side,
              calculatedSize: order.size,
              price: order.price,
              timestamp: new Date().toISOString(),
            });
            continue;
          }
          logger.info(
            `Min token fallback: sizer gave ${order.size.toFixed(2)} tokens < 5 — using trader's size: ${trade.size.toFixed(2)} tokens @ $${trade.price.toFixed(4)} ($${exactUsdc.toFixed(2)})`,
          );
          order.size = trade.size;
          order.price = trade.price;
          order.usdcAmount = exactUsdc;
        }

        // Get current price for execution (no slippage gate — execute at market)
        const currentPrice = await this.tracker.getTokenPrice(
          trade.tokenId,
          trade.side,
        );

        // Skip if market is dead (price 0 or unavailable = expired/resolved)
        if (currentPrice === null || currentPrice <= 0) {
          logger.warn(`Market price unavailable (${currentPrice}) — market likely expired, skipping | ${order.title} [${order.outcome}]`);
          continue;
        }

        const slippagePct = Math.abs(order.price - currentPrice) / order.price * 100;
        logger.info(
          `Price: trader $${order.price.toFixed(4)} → current $${currentPrice.toFixed(4)} (${slippagePct.toFixed(1)}% diff)`,
        );
        order.price = currentPrice;
        order.size = order.usdcAmount / currentPrice;

        // After price update, ensure still >= 5 tokens — round up if needed
        if (order.size < 5) {
          const minUsdc = 5 * currentPrice;
          if (trade.side === "BUY" && minUsdc > balance) {
            logger.warn(`Post-price min token: need $${minUsdc.toFixed(2)} for 5 tokens but only $${balance.toFixed(2)} — skipping`);
            continue;
          }
          logger.info(`Post-price round-up: ${order.size.toFixed(2)} tokens < 5 → rounding to 5 tokens @ $${currentPrice.toFixed(4)} ($${minUsdc.toFixed(2)})`);
          order.size = 5;
          order.usdcAmount = minUsdc;
        }

        // Guard against NaN/Infinity from division
        if (!isFinite(order.size) || order.size <= 0 || !isFinite(order.usdcAmount)) {
          logger.warn(`Invalid order values: size=${order.size}, usdc=${order.usdcAmount} — skipping`);
          continue;
        }

        const result = await this.engine.execute(order);

        if (result.success) {
          // Calculate Polymarket fee: shares × price × 0.10 × (price × (1 - price))²
          const p = result.filledPrice ?? order.price;
          const s = result.filledSize ?? order.size;
          const fee = s * p * 0.10 * Math.pow(p * (1 - p), 2);
          if (this.paperEngine) {
            this.paperEngine.addFee(fee);
          } else if (this.engine instanceof LiveTradingEngine) {
            (this.engine as any).addFee(fee);
          }

          logger.info(
            `Executed: ${result.paper ? "PAPER" : "LIVE"} ${order.side} ${s.toFixed(4)} @ $${p.toFixed(4)} | fee: $${fee.toFixed(4)} | ${order.title} [${order.outcome}] (order: ${result.orderId})`,
          );

          // Check actual fee rate from CLOB (non-blocking)
          this.checkFeeRate(order.tokenId).catch(() => {});
        } else {
          logger.error(`Execution failed: ${result.error}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Error processing trade ${trade.transactionHash}: ${msg}`);
      }
    }
  }

  private async printPnLSnapshot(): Promise<void> {
    try {
      const positions = this.engine.getPositions();
      const entries = Object.entries(positions);

      const balance = await this.engine.getBalance();
      const realizedPnL = this.engine.getRealizedPnL();

      let openInvested = 0;
      let openCurrentValue = 0;
      let openUnrealizedPnL = 0;
      let pendingCost = 0;
      let pendingCount = 0;
      const statsPositions: StatsPosition[] = [];

      logger.info("--- P&L SNAPSHOT ---");

      for (const [, pos] of entries) {
        const currentPrice = await this.tracker.getTokenPrice(pos.tokenId, "BUY");
        const invested = pos.size * pos.avgPrice;

        if (currentPrice !== null) {
          const currentValue = pos.size * currentPrice;
          const unrealizedPnL = currentValue - invested;
          const pnlPct = invested > 0 ? (unrealizedPnL / invested) * 100 : 0;
          openInvested += invested;
          openCurrentValue += currentValue;
          openUnrealizedPnL += unrealizedPnL;

          const sign = unrealizedPnL >= 0 ? "+" : "";
          logger.info(
            `  ${pos.title} [${pos.outcome}] | ${pos.size.toFixed(2)} @ $${pos.avgPrice.toFixed(4)} -> $${currentPrice.toFixed(4)} | ${sign}$${unrealizedPnL.toFixed(2)} (${sign}${pnlPct.toFixed(1)}%)`,
          );

          statsPositions.push({ title: pos.title, outcome: pos.outcome, size: pos.size, avgPrice: pos.avgPrice, currentPrice, pnl: unrealizedPnL, pending: false });
        } else {
          pendingCost += invested;
          pendingCount++;
          logger.info(
            `  [PENDING] ${pos.title} [${pos.outcome}] | ${pos.size.toFixed(2)} @ $${pos.avgPrice.toFixed(4)} — awaiting settlement`,
          );

          statsPositions.push({ title: pos.title, outcome: pos.outcome, size: pos.size, avgPrice: pos.avgPrice, currentPrice: null, pnl: null, pending: true });
        }
      }

      const totalPortfolio = balance + openCurrentValue + pendingCost;
      const overallPnL = totalPortfolio - PAPER_BALANCE;
      const realizedSign = realizedPnL >= 0 ? "+" : "";
      const unrealizedSign = openUnrealizedPnL >= 0 ? "+" : "";
      const overallSign = overallPnL >= 0 ? "+" : "";

      const winRate = this.engine.getWinRate();

      let summaryLine = `  Cash: $${balance.toFixed(2)} | Realized P&L: ${realizedSign}$${realizedPnL.toFixed(2)}`;
      if ((winRate.wins + winRate.losses) > 0) {
        summaryLine += ` | Win Rate: ${winRate.rate.toFixed(0)}% (${winRate.wins}W/${winRate.losses}L)`;
      }
      summaryLine += ` | Open: $${openInvested.toFixed(2)} (P&L: ${unrealizedSign}$${openUnrealizedPnL.toFixed(2)})`;
      if (pendingCount > 0) {
        summaryLine += ` | Pending: $${pendingCost.toFixed(2)} (${pendingCount} market${pendingCount > 1 ? "s" : ""})`;
      }
      summaryLine += ` | Portfolio: $${totalPortfolio.toFixed(2)} (${overallSign}${overallPnL.toFixed(2)})`;

      logger.info(summaryLine);
      logger.info("--------------------");

      // Send telegram notification
      await this.telegram.notifySnapshot(
        balance, realizedPnL, openInvested, openUnrealizedPnL,
        pendingCost, pendingCount, totalPortfolio,
        winRate.wins, winRate.losses, winRate.rate,
      );

      // Save stats for dashboard
      const totalFees = this.engine.getTotalFees();

      this.statsCollector.saveSnapshot({
        timestamp: new Date().toISOString(),
        cash: balance,
        realizedPnL,
        openInvested,
        openPnL: openUnrealizedPnL,
        pendingCost,
        pendingCount,
        portfolio: totalPortfolio,
        overallPnL,
        wins: winRate.wins,
        losses: winRate.losses,
        winRate: winRate.rate,
        totalFees,
        positions: statsPositions,
        skippedMinSize: this.skippedMinSize,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to print P&L snapshot: ${msg}`);
    }
  }

  private async checkFeeRate(tokenId: string): Promise<void> {
    try {
      const resp = await axios.get(`https://clob.polymarket.com/fee-rate`, {
        params: { token_id: tokenId },
        timeout: 5000,
      });
      logger.info(`Fee rate check: ${JSON.stringify(resp.data)}`);
    } catch (err: any) {
      const status = err?.response?.status;
      const msg = err instanceof Error ? err.message : String(err);
      logger.info(`Fee rate check failed (${status}): ${msg}`);
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

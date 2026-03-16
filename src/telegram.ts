import axios from "axios";
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_MILESTONE_STEP, PAPER_BALANCE } from "./config";
import logger from "./logger";

const API_URL = TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`
  : "";

export class TelegramNotifier {
  private enabled: boolean;
  private lastMilestone: number = 0;
  private dailySummaryTimer: ReturnType<typeof setInterval> | null = null;
  private lastTradeTime: number = Date.now();
  private inactivityTimer: ReturnType<typeof setInterval> | null = null;
  private dailyStats = { trades: 0, wins: 0, losses: 0, startPnL: 0, startSet: false };

  constructor() {
    this.enabled = !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
    if (this.enabled) {
      logger.info("Telegram notifications enabled");
      this.scheduleDailySummary();
      this.scheduleInactivityCheck();
    } else {
      logger.info("Telegram notifications disabled (no token/chat_id configured)");
    }
  }

  private async send(message: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await axios.post(API_URL, {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }, { timeout: 10_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Telegram send failed: ${msg}`);
    }
  }

  async notifyStartup(): Promise<void> {
    await this.send("🤖 <b>Bot Started</b>\nPolymarket Copy Bot is now running.");
  }

  async notifyShutdown(): Promise<void> {
    await this.send("🛑 <b>Bot Stopped</b>\nPolymarket Copy Bot has shut down.");
  }

  async notifySettlement(title: string, outcome: string, won: boolean, tokens: number, payout: number, pnl: number): Promise<void> {
    const icon = won ? "✅" : "❌";
    const sign = pnl >= 0 ? "+" : "";
    await this.send(
      `${icon} <b>SETTLED</b>: ${title} [${outcome}]\n` +
      `Result: ${won ? "WON" : "LOST"} | ${tokens.toFixed(2)} tokens\n` +
      `Payout: $${payout.toFixed(2)} | P&L: ${sign}$${pnl.toFixed(2)}`
    );
    this.dailyStats.trades++;
    if (won) this.dailyStats.wins++;
    else this.dailyStats.losses++;
  }

  async notifySnapshot(cash: number, realizedPnL: number, openInvested: number, openPnL: number, pendingCost: number, pendingCount: number, portfolio: number, wins: number, losses: number, winRate: number): Promise<void> {
    const overallPnL = portfolio - PAPER_BALANCE;
    const overallSign = overallPnL >= 0 ? "+" : "";
    const realizedSign = realizedPnL >= 0 ? "+" : "";
    const openSign = openPnL >= 0 ? "+" : "";
    const winTotal = wins + losses;
    const winRateText = winTotal > 0 ? `${winRate.toFixed(0)}% (${wins}W/${losses}L)` : "N/A";

    let msg = `📊 <b>P&L Snapshot</b>\n`;
    msg += `Cash: $${cash.toFixed(2)}\n`;
    msg += `Realized P&L: ${realizedSign}$${realizedPnL.toFixed(2)}\n`;
    msg += `Win Rate: ${winRateText}\n`;
    msg += `Open: $${openInvested.toFixed(2)} (P&L: ${openSign}$${openPnL.toFixed(2)})\n`;
    if (pendingCount > 0) {
      msg += `Pending: $${pendingCost.toFixed(2)} (${pendingCount} market${pendingCount > 1 ? "s" : ""})\n`;
    }
    msg += `\n💰 <b>Portfolio: $${portfolio.toFixed(2)} (${overallSign}${overallPnL.toFixed(2)})</b>`;

    await this.send(msg);

    // Track daily stats start
    if (!this.dailyStats.startSet) {
      this.dailyStats.startPnL = realizedPnL;
      this.dailyStats.startSet = true;
    }

    // Check milestones
    await this.checkMilestone(overallPnL);

    this.lastTradeTime = Date.now();
  }

  async notifyError(error: string): Promise<void> {
    await this.send(`⚠️ <b>Bot Error</b>\n${error}`);
  }

  private async checkMilestone(overallPnL: number): Promise<void> {
    const currentMilestone = Math.floor(overallPnL / TELEGRAM_MILESTONE_STEP) * TELEGRAM_MILESTONE_STEP;
    if (currentMilestone > this.lastMilestone && currentMilestone > 0) {
      this.lastMilestone = currentMilestone;
      await this.send(
        `🎯 <b>Milestone Reached!</b>\n` +
        `Portfolio is now +$${currentMilestone.toFixed(0)} above starting balance!`
      );
    }
    // Alert if portfolio drops below start
    if (overallPnL < 0 && this.lastMilestone >= 0) {
      this.lastMilestone = -1;
      await this.send(
        `🔴 <b>Warning!</b>\nPortfolio has dropped below starting balance ($${PAPER_BALANCE})`
      );
    }
  }

  private scheduleDailySummary(): void {
    // Check every minute if it's midnight
    this.dailySummaryTimer = setInterval(async () => {
      const now = new Date();
      if (now.getHours() === 0 && now.getMinutes() === 0) {
        const { trades, wins, losses, startPnL } = this.dailyStats;
        const total = wins + losses;
        const rate = total > 0 ? ((wins / total) * 100).toFixed(0) : "N/A";
        await this.send(
          `📅 <b>Daily Summary</b>\n` +
          `Settlements today: ${total} (${wins}W/${losses}L)\n` +
          `Win Rate: ${rate}%\n` +
          `Total trades: ${trades}`
        );
        // Reset daily stats
        this.dailyStats = { trades: 0, wins: 0, losses: 0, startPnL: 0, startSet: false };
      }
    }, 60_000);
  }

  private scheduleInactivityCheck(): void {
    // Check every 10 minutes if trader has been inactive for 30+ minutes
    this.inactivityTimer = setInterval(async () => {
      const elapsed = Date.now() - this.lastTradeTime;
      if (elapsed > 30 * 60 * 1000) {
        await this.send(
          `💤 <b>Inactivity Alert</b>\nNo trades detected in the last 30 minutes. Trader might be inactive.`
        );
        // Reset to avoid spamming — next alert in 30 more minutes
        this.lastTradeTime = Date.now();
      }
    }, 10 * 60 * 1000);
  }

  stop(): void {
    if (this.dailySummaryTimer) clearInterval(this.dailySummaryTimer);
    if (this.inactivityTimer) clearInterval(this.inactivityTimer);
  }
}

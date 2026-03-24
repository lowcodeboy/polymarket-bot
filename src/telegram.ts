import axios from "axios";
import fs from "fs";
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_MILESTONE_STEP, PAPER_BALANCE, PAPER_TRADING } from "./config";
import logger from "./logger";
import { isPaused, setPaused } from "./control";
import type { StatsCollector } from "./stats";

const API_BASE = TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
  : "";
const API_URL = API_BASE ? `${API_BASE}/sendMessage` : "";

const MODE_TAG = PAPER_TRADING ? "[PAPER]" : "[LIVE]";

export type CommandHandler = (chatId: string) => Promise<void>;

export class TelegramNotifier {
  private enabled: boolean;
  private lastMilestone: number = 0;
  private dailySummaryTimer: ReturnType<typeof setInterval> | null = null;
  private lastTradeTime: number = Date.now();
  private inactivityTimer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshotSent: number = 0;
  private dailyStats = { trades: 0, wins: 0, losses: 0, startPnL: 0, startSet: false };
  private commandHandlers: Map<string, CommandHandler> = new Map();
  private statsCollector: StatsCollector | null = null;

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

  setStatsCollector(sc: StatsCollector): void {
    this.statsCollector = sc;
    this.registerDefaultCommands();
  }

  private registerDefaultCommands(): void {
    this.commandHandlers.set("/snapshot", async (chatId) => {
      if (!this.statsCollector) return;
      const stats = this.statsCollector.getStats();
      if (!stats.current) {
        await this.sendTo(chatId, "📊 No data yet — waiting for first trade.");
        return;
      }
      const s = stats.current;
      const overallPnL = s.portfolio - PAPER_BALANCE;
      const overallSign = overallPnL >= 0 ? "+" : "";
      const realizedSign = s.realizedPnL >= 0 ? "+" : "";
      const openSign = s.openPnL >= 0 ? "+" : "";
      const winTotal = s.wins + s.losses;
      const winRateText = winTotal > 0 ? `${s.winRate.toFixed(0)}% (${s.wins}W/${s.losses}L)` : "N/A";

      let msg = `📊 <b>${MODE_TAG} P&L Snapshot</b>\n`;
      msg += `Cash: $${s.cash.toFixed(2)}\n`;
      msg += `Realized P&L: ${realizedSign}$${s.realizedPnL.toFixed(2)}\n`;
      msg += `Win Rate: ${winRateText}\n`;
      msg += `Open: $${s.openInvested.toFixed(2)} (P&L: ${openSign}$${s.openPnL.toFixed(2)})\n`;
      if (s.pendingCount > 0) {
        msg += `Pending: $${s.pendingCost.toFixed(2)} (${s.pendingCount} market${s.pendingCount > 1 ? "s" : ""})\n`;
      }
      msg += `\n💰 <b>Portfolio: $${s.portfolio.toFixed(2)} (${overallSign}${overallPnL.toFixed(2)})</b>`;
      await this.sendTo(chatId, msg);
    });

    this.commandHandlers.set("/positions", async (chatId) => {
      if (!this.statsCollector) return;
      const stats = this.statsCollector.getStats();
      if (!stats.current || stats.current.positions.length === 0) {
        await this.sendTo(chatId, "📋 No open positions.");
        return;
      }
      let msg = `📋 <b>${MODE_TAG} Open Positions</b>\n\n`;
      for (const p of stats.current.positions) {
        const status = p.pending ? "⏳" : "🟢";
        const current = p.currentPrice !== null ? `$${p.currentPrice.toFixed(4)}` : "---";
        const pnl = p.pnl !== null ? (p.pnl >= 0 ? `+$${p.pnl.toFixed(2)}` : `-$${Math.abs(p.pnl).toFixed(2)}`) : "---";
        msg += `${status} ${p.title} [${p.outcome}]\n`;
        msg += `   ${p.size.toFixed(2)} @ $${p.avgPrice.toFixed(4)} → ${current} | ${pnl}\n\n`;
      }
      await this.sendTo(chatId, msg);
    });

    this.commandHandlers.set("/balance", async (chatId) => {
      if (!this.statsCollector) return;
      const stats = this.statsCollector.getStats();
      if (!stats.current) {
        await this.sendTo(chatId, "💵 No data yet.");
        return;
      }
      await this.sendTo(chatId, `💵 <b>${MODE_TAG} Cash Balance:</b> $${stats.current.cash.toFixed(2)}`);
    });

    // Control commands — paper mode
    this.commandHandlers.set("/go-paper", async (chatId) => {
      if (!PAPER_TRADING) {
        await this.sendTo(chatId, "⚠️ This bot is running in LIVE mode. Use /go instead.");
        return;
      }
      setPaused(false);
      await this.sendTo(chatId, `▶️ <b>${MODE_TAG} Bot ACTIVATED</b>\nPaper bot is now placing orders.`);
    });

    this.commandHandlers.set("/pause-paper", async (chatId) => {
      if (!PAPER_TRADING) {
        await this.sendTo(chatId, "⚠️ This bot is running in LIVE mode. Use /pause instead.");
        return;
      }
      setPaused(true);
      await this.sendTo(chatId, `⏸ <b>${MODE_TAG} Bot PAUSED</b>\nPaper bot stopped placing orders. Settlements continue.`);
    });

    // Control commands — live mode
    this.commandHandlers.set("/go", async (chatId) => {
      if (PAPER_TRADING) {
        await this.sendTo(chatId, "⚠️ This bot is running in PAPER mode. Use /go-paper instead.");
        return;
      }
      setPaused(false);
      await this.sendTo(chatId, `🟢 <b>${MODE_TAG} Bot ACTIVATED</b>\nLive bot is now placing orders. Be careful!`);
    });

    this.commandHandlers.set("/pause", async (chatId) => {
      if (PAPER_TRADING) {
        await this.sendTo(chatId, "⚠️ This bot is running in PAPER mode. Use /pause-paper instead.");
        return;
      }
      setPaused(true);
      await this.sendTo(chatId, `⏸ <b>${MODE_TAG} Bot PAUSED</b>\nLive bot stopped placing orders. Settlements continue.`);
    });

    // Status command
    this.commandHandlers.set("/status", async (chatId) => {
      const status = isPaused() ? "⏸ PAUSED" : "▶️ ACTIVE";
      await this.sendTo(chatId, `${status} — ${MODE_TAG} bot is ${isPaused() ? "not placing orders" : "placing orders"}`);
    });

    this.commandHandlers.set("/help", async (chatId) => {
      await this.sendTo(chatId,
        `🤖 <b>${MODE_TAG} Bot Commands</b>\n\n` +
        `/snapshot — Current P&L snapshot\n` +
        `/positions — Open positions\n` +
        `/balance — Cash balance\n` +
        `/status — Check if bot is active or paused\n` +
        (PAPER_TRADING
          ? `/go-paper — Start placing orders\n/pause-paper — Stop placing orders\n`
          : `/go — Start placing orders\n/pause — Stop placing orders\n`) +
        `/help — Show this message`
      );
    });
  }

  async handleWebhook(body: any): Promise<void> {
    const message = body?.message;
    if (!message?.text || !message?.chat?.id) return;

    const chatId = String(message.chat.id);
    // Only respond to our configured chat
    if (chatId !== TELEGRAM_CHAT_ID) {
      logger.warn(`Telegram webhook from unauthorized chat: ${chatId}`);
      return;
    }

    const command = message.text.trim().split(" ")[0].toLowerCase();
    const handler = this.commandHandlers.get(command);
    if (handler) {
      logger.info(`Telegram command: ${command}`);
      await handler(chatId);
    }
  }

  async registerWebhook(publicUrl: string, certPath: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const fs = await import("fs");
      const FormData = (await import("form-data")).default;
      const form = new FormData();
      form.append("url", publicUrl);
      form.append("certificate", fs.createReadStream(certPath));
      form.append("allowed_updates", JSON.stringify(["message"]));

      const resp = await axios.post(`${API_BASE}/setWebhook`, form, {
        headers: form.getHeaders(),
        timeout: 10_000,
      });
      if (resp.data?.ok) {
        logger.info(`Telegram webhook registered: ${publicUrl}`);
      } else {
        logger.warn(`Telegram webhook registration failed: ${JSON.stringify(resp.data)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to register Telegram webhook: ${msg}`);
    }
  }

  private async sendTo(chatId: string, message: string): Promise<void> {
    if (!API_URL) return;
    try {
      await axios.post(API_URL, {
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
      }, { timeout: 10_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Telegram send failed: ${msg}`);
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
    await this.send(`🤖 <b>${MODE_TAG} Bot Started</b>\nPolymarket Copy Bot is now running.`);
  }

  async notifyShutdown(): Promise<void> {
    await this.send(`🛑 <b>${MODE_TAG} Bot Stopped</b>\nPolymarket Copy Bot has shut down.`);
  }

  async notifySettlement(title: string, outcome: string, won: boolean, tokens: number, payout: number, pnl: number): Promise<void> {
    if (PAPER_TRADING) return; // Only send settlement alerts in live mode
    const icon = won ? "✅" : "❌";
    const sign = pnl >= 0 ? "+" : "";
    await this.send(
      `${icon} <b>${MODE_TAG} SETTLED</b>: ${title} [${outcome}]\n` +
      `Result: ${won ? "WON" : "LOST"} | ${tokens.toFixed(2)} tokens\n` +
      `Payout: $${payout.toFixed(2)} | P&L: ${sign}$${pnl.toFixed(2)}`
    );
    this.dailyStats.trades++;
    if (won) this.dailyStats.wins++;
    else this.dailyStats.losses++;
  }

  async notifySnapshot(cash: number, realizedPnL: number, openInvested: number, openPnL: number, pendingCost: number, pendingCount: number, portfolio: number, wins: number, losses: number, winRate: number): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastSnapshotSent;

    // Only send snapshot every 30 minutes
    if (elapsed < 30 * 60 * 1000 && this.lastSnapshotSent > 0) {
      // Still update daily stats and check milestones
      if (!this.dailyStats.startSet) {
        this.dailyStats.startPnL = realizedPnL;
        this.dailyStats.startSet = true;
      }
      await this.checkMilestone(portfolio - PAPER_BALANCE);
      this.lastTradeTime = now;
      return;
    }

    this.lastSnapshotSent = now;

    const overallPnL = portfolio - PAPER_BALANCE;
    const overallSign = overallPnL >= 0 ? "+" : "";
    const realizedSign = realizedPnL >= 0 ? "+" : "";
    const openSign = openPnL >= 0 ? "+" : "";
    const winTotal = wins + losses;
    const winRateText = winTotal > 0 ? `${winRate.toFixed(0)}% (${wins}W/${losses}L)` : "N/A";

    let msg = `📊 <b>${MODE_TAG} P&L Snapshot</b>\n`;
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

  async notifySignal(peakValue: number, drawdownBottom: number, recoveryValue: number, portfolio: number, traderValue: number, winRate: number, wins: number, losses: number): Promise<void> {
    const drawdownPct = ((peakValue - drawdownBottom) / peakValue * 100).toFixed(1);
    const recoveryPct = ((recoveryValue - drawdownBottom) / (peakValue - drawdownBottom) * 100).toFixed(1);
    const winTotal = wins + losses;
    const winRateText = winTotal > 0 ? `${winRate.toFixed(0)}% (${wins}W/${losses}L)` : "N/A";

    let msg = `🚀 <b>${MODE_TAG} GO-LIVE SIGNAL</b>\n\n`;
    msg += `Recovery detected after drawdown:\n`;
    msg += `Peak: $${peakValue.toFixed(2)}\n`;
    msg += `Bottom: $${drawdownBottom.toFixed(2)} (-${drawdownPct}%)\n`;
    msg += `Recovery: $${recoveryValue.toFixed(2)} (${recoveryPct}% recovered)\n\n`;
    msg += `📊 Current Portfolio: $${portfolio.toFixed(2)}\n`;
    msg += `👤 Trader Value: $${traderValue.toFixed(2)}\n`;
    msg += `Win Rate: ${winRateText}\n\n`;
    msg += `💡 <i>Favorable entry point detected</i>`;

    await this.send(msg);
  }

  async notifyError(error: string): Promise<void> {
    await this.send(`⚠️ <b>${MODE_TAG} Bot Error</b>\n${error}`);
  }

  private async checkMilestone(overallPnL: number): Promise<void> {
    const currentMilestone = Math.floor(overallPnL / TELEGRAM_MILESTONE_STEP) * TELEGRAM_MILESTONE_STEP;
    if (currentMilestone > this.lastMilestone && currentMilestone > 0) {
      this.lastMilestone = currentMilestone;
      await this.send(
        `🎯 <b>${MODE_TAG} Milestone Reached!</b>\n` +
        `Portfolio is now +$${currentMilestone.toFixed(0)} above starting balance!`
      );
    }
    // Alert if portfolio drops below start
    if (overallPnL < 0 && this.lastMilestone >= 0) {
      this.lastMilestone = -1;
      await this.send(
        `🔴 <b>${MODE_TAG} Warning!</b>\nPortfolio has dropped below starting balance ($${PAPER_BALANCE})`
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
          `📅 <b>${MODE_TAG} Daily Summary</b>\n` +
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
          `💤 <b>${MODE_TAG} Inactivity Alert</b>\nNo trades detected in the last 30 minutes. Trader might be inactive.`
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

import logger from "./logger";
import type { StatsCollector } from "./stats";
import type { TelegramNotifier } from "./telegram";

// Time windows in milliseconds
const PEAK_LOOKBACK_MS = 90 * 60 * 1000;     // 1h30 lookback for peak detection
const DRAWDOWN_CONFIRM_MS = 15 * 60 * 1000;  // 15 min after peak to confirm drawdown
const DRAWDOWN_PHASE_MS = 45 * 60 * 1000;    // ~45 min total drawdown from peak
const RECOVERY_WINDOW_MS = 15 * 60 * 1000;   // last 15 min to detect recovery
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;    // 1h cooldown between alerts
const MIN_SNAPSHOTS = 10;                      // minimum snapshots needed to analyze

export interface SignalEvent {
  timestamp: string;
  peakValue: number;
  drawdownBottom: number;
  recoveryValue: number;
  traderValue: number;
  portfolio: number;
  winRate: number;
}

export class SignalDetector {
  private statsCollector: StatsCollector;
  private telegram: TelegramNotifier;
  private lastAlertTime = 0;
  private signals: SignalEvent[] = [];

  constructor(statsCollector: StatsCollector, telegram: TelegramNotifier) {
    this.statsCollector = statsCollector;
    this.telegram = telegram;
  }

  getSignals(): SignalEvent[] {
    return this.signals;
  }

  async check(traderValue: number): Promise<void> {
    const now = Date.now();

    // Cooldown check
    if (now - this.lastAlertTime < ALERT_COOLDOWN_MS && this.lastAlertTime > 0) {
      return;
    }

    const stats = this.statsCollector.getStats();
    const history = stats.history;
    if (history.length < MIN_SNAPSHOTS) return;

    // Get snapshots from the last 1h30
    const cutoff = now - PEAK_LOOKBACK_MS;
    const recent = history.filter(h => new Date(h.timestamp).getTime() >= cutoff);
    if (recent.length < MIN_SNAPSHOTS) return;

    // Step 1: Find the peak (highest portfolio in last 1h30)
    let peakValue = -Infinity;
    let peakTime = 0;
    for (const snap of recent) {
      if (snap.portfolio > peakValue) {
        peakValue = snap.portfolio;
        peakTime = new Date(snap.timestamp).getTime();
      }
    }

    // Peak must be at least 45 min ago (need time for drawdown + recovery)
    const timeSincePeak = now - peakTime;
    if (timeSincePeak < DRAWDOWN_PHASE_MS) return;

    // Step 2: Confirm drawdown 15 min after peak
    const confirmStart = peakTime;
    const confirmEnd = peakTime + DRAWDOWN_CONFIRM_MS;
    const confirmSnapshots = recent.filter(h => {
      const t = new Date(h.timestamp).getTime();
      return t >= confirmStart && t <= confirmEnd;
    });

    if (confirmSnapshots.length < 3) return;

    const confirmAvg = confirmSnapshots.reduce((sum, h) => sum + h.portfolio, 0) / confirmSnapshots.length;

    // Average must be below peak
    if (confirmAvg >= peakValue) return;

    // Check downward trend in confirmation window
    const confirmFirst = confirmSnapshots.slice(0, Math.floor(confirmSnapshots.length / 2));
    const confirmSecond = confirmSnapshots.slice(Math.floor(confirmSnapshots.length / 2));
    const confirmFirstAvg = confirmFirst.reduce((sum, h) => sum + h.portfolio, 0) / confirmFirst.length;
    const confirmSecondAvg = confirmSecond.reduce((sum, h) => sum + h.portfolio, 0) / confirmSecond.length;

    if (confirmSecondAvg >= confirmFirstAvg) return; // Not trending down

    // Step 3: Drawdown phase — portfolio stays below peak for ~45 min
    const drawdownEnd = peakTime + DRAWDOWN_PHASE_MS;
    const drawdownSnapshots = recent.filter(h => {
      const t = new Date(h.timestamp).getTime();
      return t >= confirmEnd && t <= drawdownEnd;
    });

    if (drawdownSnapshots.length < 3) return;

    const drawdownAvg = drawdownSnapshots.reduce((sum, h) => sum + h.portfolio, 0) / drawdownSnapshots.length;

    // Average during drawdown must be below peak
    if (drawdownAvg >= peakValue) return;

    // Find the bottom of the drawdown
    const drawdownBottom = Math.min(...drawdownSnapshots.map(h => h.portfolio));

    // Step 4: Recovery detection — last 15 min trending upward
    const recoveryStart = now - RECOVERY_WINDOW_MS;
    const recoverySnapshots = recent.filter(h => {
      const t = new Date(h.timestamp).getTime();
      return t >= recoveryStart;
    });

    if (recoverySnapshots.length < 3) return;

    // Split recovery window into two halves
    const halfIdx = Math.floor(recoverySnapshots.length / 2);
    const recoveryFirstHalf = recoverySnapshots.slice(0, halfIdx);
    const recoverySecondHalf = recoverySnapshots.slice(halfIdx);

    const recoveryFirstAvg = recoveryFirstHalf.reduce((sum, h) => sum + h.portfolio, 0) / recoveryFirstHalf.length;
    const recoverySecondAvg = recoverySecondHalf.reduce((sum, h) => sum + h.portfolio, 0) / recoverySecondHalf.length;

    // Second half must be higher than first half (upward trend)
    if (recoverySecondAvg <= recoveryFirstAvg) return;

    // Also check: the previous 15 min (before recovery) had lower average
    const preRecoveryStart = recoveryStart - RECOVERY_WINDOW_MS;
    const preRecoverySnapshots = recent.filter(h => {
      const t = new Date(h.timestamp).getTime();
      return t >= preRecoveryStart && t < recoveryStart;
    });

    if (preRecoverySnapshots.length > 0) {
      const preRecoveryAvg = preRecoverySnapshots.reduce((sum, h) => sum + h.portfolio, 0) / preRecoverySnapshots.length;
      // Recovery average must be higher than pre-recovery average
      if (recoverySecondAvg <= preRecoveryAvg) return;
    }

    // Step 5: Check trader is active (has new trades in recent snapshots)
    const lastSnap = history[history.length - 1];
    const prevSnap = history.length > 5 ? history[history.length - 5] : null;
    if (prevSnap) {
      const positionsChanged = lastSnap.positions.length !== prevSnap.positions.length ||
        lastSnap.wins !== prevSnap.wins || lastSnap.losses !== prevSnap.losses;
      if (!positionsChanged) return; // Trader not active
    }

    // All conditions met — fire signal!
    const currentPortfolio = lastSnap.portfolio;
    const signal: SignalEvent = {
      timestamp: new Date().toISOString(),
      peakValue,
      drawdownBottom,
      recoveryValue: recoverySecondAvg,
      traderValue,
      portfolio: currentPortfolio,
      winRate: lastSnap.winRate,
    };

    this.signals.push(signal);
    this.lastAlertTime = now;
    this.statsCollector.addSignal(signal.timestamp);

    const drawdownPct = ((peakValue - drawdownBottom) / peakValue * 100).toFixed(1);
    const recoveryPct = ((recoverySecondAvg - drawdownBottom) / (peakValue - drawdownBottom) * 100).toFixed(1);

    logger.info(
      `SIGNAL: Go-live entry detected | Peak: $${peakValue.toFixed(2)} → Bottom: $${drawdownBottom.toFixed(2)} (-${drawdownPct}%) → Recovery: $${recoverySecondAvg.toFixed(2)} (${recoveryPct}% recovered)`,
    );

    await this.telegram.notifySignal(
      peakValue, drawdownBottom, recoverySecondAvg, currentPortfolio,
      traderValue, lastSnap.winRate, lastSnap.wins, lastSnap.losses,
    );
  }
}

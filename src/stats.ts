import fs from "fs";

const STATS_FILE = "dashboard_stats.json";
const MAX_HISTORY = 20000; // ~7 days of data

export interface SkippedTrade {
  title: string;
  outcome: string;
  side: string;
  calculatedSize: number;
  price: number;
  timestamp: string;
}

export interface StatsSnapshot {
  timestamp: string;
  cash: number;
  realizedPnL: number;
  openInvested: number;
  openPnL: number;
  pendingCost: number;
  pendingCount: number;
  portfolio: number;
  overallPnL: number;
  wins: number;
  losses: number;
  winRate: number;
  totalFees: number;
  positions: StatsPosition[];
  skippedMinSize?: SkippedTrade[];
}

export interface StatsPosition {
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentPrice: number | null;
  pnl: number | null;
  pending: boolean;
}

export interface DashboardStats {
  current: StatsSnapshot | null;
  history: StatsSnapshot[];
  startBalance: number;
  signals?: string[]; // timestamps of go-live signals
}

export class StatsCollector {
  private stats: DashboardStats;

  constructor(startBalance: number) {
    this.stats = this.load(startBalance);
  }

  private load(startBalance: number): DashboardStats {
    try {
      if (fs.existsSync(STATS_FILE)) {
        const raw = fs.readFileSync(STATS_FILE, "utf-8");
        const data = JSON.parse(raw) as DashboardStats;
        return {
          current: data.current ?? null,
          history: data.history ?? [],
          startBalance: data.startBalance ?? startBalance,
          signals: data.signals ?? [],
        };
      }
    } catch {}
    return { current: null, history: [], startBalance, signals: [] };
  }

  saveSnapshot(snapshot: StatsSnapshot): void {
    this.stats.current = snapshot;
    this.stats.history.push(snapshot);
    if (this.stats.history.length > MAX_HISTORY) {
      this.stats.history = this.stats.history.slice(-MAX_HISTORY);
    }
    try {
      fs.writeFileSync(STATS_FILE, JSON.stringify(this.stats), "utf-8");
    } catch {}
  }

  addSignal(timestamp: string): void {
    if (!this.stats.signals) this.stats.signals = [];
    this.stats.signals.push(timestamp);
    try {
      fs.writeFileSync(STATS_FILE, JSON.stringify(this.stats), "utf-8");
    } catch {}
  }

  getStats(): DashboardStats {
    return this.stats;
  }
}

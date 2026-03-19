import fs from "fs";
import axios from "axios";
import { DATA_API, CLOB_HOST } from "./config";
import logger from "./logger";
import type { DetectedTrade } from "./types";

const HTTP_TIMEOUT = 10_000;
const STATE_FILE = "bot_state.json";

interface TrackerState {
  lastSeen: Record<string, number>;
}

// Convert any timestamp format (ISO string, Unix seconds, Unix ms) to Unix ms
function toEpochMs(ts: unknown): number {
  if (typeof ts === "number") {
    // If it looks like seconds (< year 2100 in seconds), convert to ms
    return ts < 1e12 ? ts * 1000 : ts;
  }
  if (typeof ts === "string" && ts.length > 0) {
    const n = Number(ts);
    if (!isNaN(n)) return n < 1e12 ? n * 1000 : n;
    const d = new Date(ts).getTime();
    if (!isNaN(d)) return d;
  }
  return 0;
}

export class TraderTracker {
  private wallets: string[];
  private lastSeen: Map<string, number>;

  constructor(wallets: string[]) {
    this.wallets = wallets;
    this.lastSeen = new Map();

    // Load persisted lastSeen timestamps or default to now
    const saved = this.loadState();
    const now = Date.now();
    for (const wallet of wallets) {
      const savedTs = saved.lastSeen[wallet];
      this.lastSeen.set(wallet, savedTs ?? now);
    }
    logger.info(`Tracking ${wallets.length} wallet(s)`);
  }

  async pollNewTrades(): Promise<DetectedTrade[]> {
    const allTrades: DetectedTrade[] = [];
    for (const wallet of this.wallets) {
      try {
        const trades = await this.fetchRecentActivity(wallet);
        allTrades.push(...trades);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to fetch activity for ${wallet}: ${msg}`);
      }
    }
    return allTrades;
  }

  private async fetchRecentActivity(wallet: string): Promise<DetectedTrade[]> {
    const url = `${DATA_API}/trades`;
    const resp = await axios.get(url, {
      params: {
        user: wallet,
        limit: 50,
        sortBy: "TIMESTAMP",
        sortDirection: "DESC",
      },
      timeout: HTTP_TIMEOUT,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activities: any[] = resp.data;
    if (!Array.isArray(activities)) return [];

    const lastSeenMs = this.lastSeen.get(wallet) ?? Date.now();
    const newTrades: DetectedTrade[] = [];
    let maxMs = lastSeenMs;

    for (const a of activities) {
      const rawTs = a.timestamp ?? a.createdAt ?? "";
      const tsMs = toEpochMs(rawTs);
      if (tsMs <= 0 || tsMs <= lastSeenMs) continue;

      if (tsMs > maxMs) maxMs = tsMs;

      const size = parseFloat(a.size ?? "0");
      const price = parseFloat(a.price ?? "0");

      newTrades.push({
        wallet,
        timestamp: new Date(tsMs).toISOString(),
        conditionId: a.conditionId ?? a.condition_id ?? "",
        tokenId: a.asset ?? a.tokenId ?? "",
        side: (a.side ?? "BUY").toUpperCase() as "BUY" | "SELL",
        size,
        price,
        usdcSize: parseFloat(
          a.usdcSize ?? a.usdc_size ?? String(size * price),
        ),
        title: a.title ?? a.question ?? "",
        slug: a.slug ?? "",
        outcome: a.outcome ?? "",
        outcomeIndex: parseInt(a.outcomeIndex ?? a.outcome_index ?? "0", 10),
        transactionHash: a.transactionHash ?? a.transaction_hash ?? "",
      });
    }

    if (maxMs > lastSeenMs) {
      this.lastSeen.set(wallet, maxMs);
      this.saveState();
    }

    return newTrades;
  }

  private loadState(): TrackerState {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, "utf-8");
        const data = JSON.parse(raw);
        return {
          lastSeen: data.lastSeen ?? {},
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to load tracker state: ${msg}`);
    }
    return { lastSeen: {} };
  }

  private saveState(): void {
    try {
      const state: TrackerState = {
        lastSeen: Object.fromEntries(this.lastSeen),
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to save tracker state: ${msg}`);
    }
  }

  async getPortfolioValue(wallet: string): Promise<number> {
    try {
      const resp = await axios.get(`${DATA_API}/value`, {
        params: { user: wallet },
        timeout: HTTP_TIMEOUT,
      });
      const data = resp.data;
      // Handle array response: [{ value: 123 }] or object: { value: 123 } or raw number
      const raw = Array.isArray(data) ? data[0]?.value : data?.value ?? data;
      const val = parseFloat(String(raw ?? "0"));
      return isNaN(val) ? 0 : val;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to get portfolio value for ${wallet}: ${msg}`);
      return 0;
    }
  }

  async getTokenPrice(tokenId: string, side: string): Promise<number | null> {
    try {
      const resp = await axios.get(`${CLOB_HOST}/price`, {
        params: { token_id: tokenId, side },
        timeout: HTTP_TIMEOUT,
      });
      const price = parseFloat(resp.data?.price ?? resp.data ?? "0");
      return isNaN(price) ? null : price;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to get token price for ${tokenId}: ${msg}`);
      return null;
    }
  }
}

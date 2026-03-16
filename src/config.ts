import dotenv from "dotenv";
dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

// Always required
export const TRACKED_WALLETS = required("TRACKED_WALLETS")
  .split(",")
  .map((w) => w.trim().toLowerCase())
  .filter((w) => w.length > 0);

if (TRACKED_WALLETS.length === 0) {
  throw new Error("TRACKED_WALLETS must contain at least one wallet address");
}

// Mode
export const PAPER_TRADING =
  optional("PAPER_TRADING", "true").toLowerCase() === "true";

// Paper trading defaults
export const PAPER_BALANCE = parseFloat(optional("PAPER_BALANCE", "1000"));

// Trading parameters
export const TRADE_MULTIPLIER = parseFloat(
  optional("TRADE_MULTIPLIER", "1.0"),
);
export const MAX_POSITION_PCT = parseFloat(
  optional("MAX_POSITION_PCT", "0.10"),
);
export const MAX_SLIPPAGE = parseFloat(optional("MAX_SLIPPAGE", "0.02"));
export const MAX_MARKET_EXPOSURE = parseFloat(optional("MAX_MARKET_EXPOSURE", "0.30"));
export const POLL_INTERVAL = parseInt(optional("POLL_INTERVAL", "5"), 10);
export const LOG_LEVEL = optional("LOG_LEVEL", "info");

// Live mode credentials (required only when PAPER_TRADING=false)
export const PRIVATE_KEY = PAPER_TRADING ? "" : required("PRIVATE_KEY");
export const FUNDER_ADDRESS = PAPER_TRADING ? "" : required("FUNDER_ADDRESS");
export const RPC_URL = PAPER_TRADING ? "" : required("RPC_URL");
export const SIGNATURE_TYPE = parseInt(optional("SIGNATURE_TYPE", "0"), 10);

// Dashboard
export const DASHBOARD_PORT = parseInt(optional("DASHBOARD_PORT", "3000"), 10);

// Telegram notifications
export const TELEGRAM_BOT_TOKEN = optional("TELEGRAM_BOT_TOKEN", "");
export const TELEGRAM_CHAT_ID = optional("TELEGRAM_CHAT_ID", "");
export const TELEGRAM_MILESTONE_STEP = parseFloat(optional("TELEGRAM_MILESTONE_STEP", "100"));

// Polymarket endpoints
export const CLOB_HOST = "https://clob.polymarket.com";
export const DATA_API = "https://data-api.polymarket.com";
export const GAMMA_API = "https://gamma-api.polymarket.com";
export const CHAIN_ID = 137;

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm run dev          # Run with ts-node (no build required)
npm run dev:paper    # Run in paper trading mode with ts-node
npm run start        # Run compiled bot
npm run start:paper  # Run compiled bot in paper mode
npm run start:live   # Run compiled bot in live mode
```

No test suite exists in this project.

For production deployment via PM2:
```bash
pm2 start ecosystem.config.js
pm2 logs
pm2 restart polymarket-bot
```

## Architecture

The bot polls Polymarket APIs, detects new trades from tracked wallets, and mirrors them through an abstracted `ITradingEngine` interface with two implementations: paper (simulated) and live (on-chain).

**Core flow** (`src/bot.ts` → `tick()`):
1. Poll `data-api.polymarket.com` for trades from `TRACKED_WALLETS`
2. Deduplicate via `processed_hashes.json`
3. Size the order (`src/sizer.ts`): scale by trader portfolio value, apply `TRADE_MULTIPLIER`, cap with `MAX_POSITION_PCT` and `MAX_MARKET_EXPOSURE`
4. Check slippage against current CLOB price
5. Execute via `ITradingEngine` (paper or live)
6. Detect settled markets, update P&L, send Telegram alerts

**Trading Engines** (`src/types.ts` → `ITradingEngine` interface):
- `PaperEngine` (`src/paper-engine.ts`): local simulation, persists to `paper_portfolio.json`, settles via Gamma API
- `LiveEngine` (`src/live-engine.ts`): uses `@polymarket/clob-client` for EIP-712 signed on-chain orders; USDC balance via Polygon RPC

**External APIs used:**
- `data-api.polymarket.com` — trader activity, portfolio values
- `gamma-api.polymarket.com` — market metadata, resolution status
- `clob.polymarket.com` — token prices, order placement
- Polygon RPC (`RPC_URL`) — USDC.e balance (contract `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`, 6 decimals)

**State persistence** (all JSON files in project root, gitignored):
- `processed_hashes.json` — dedup set (max 10k hashes)
- `paper_portfolio.json` / `live_portfolio.json` — balance, positions, trade history
- `bot_state.json` — last-seen timestamps per wallet
- `dashboard_stats.json` — historical P&L snapshots for charting

**Dashboard** (`src/dashboard.ts`): HTTP server on `DASHBOARD_PORT` (default 3000), serves `/api/stats` and an inline HTML UI with portfolio/P&L charts and a day-filter selector.

**Telegram** (`src/telegram.ts`): optional notifications for trade executions, settlements, 30-min P&L snapshots, milestones, inactivity alerts (30 min), and midnight daily summaries. All messages are prefixed with `[PAPER]` or `[LIVE]`.

## Key Configuration (`.env`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `TRACKED_WALLETS` | Yes | — | Comma-separated 0x addresses |
| `PAPER_TRADING` | No | `true` | Set `false` for live mode |
| `PAPER_BALANCE` | No | `1000` | Starting simulated balance |
| `TRADE_MULTIPLIER` | No | `1.0` | Scale factor applied to all orders |
| `MAX_POSITION_PCT` | No | `0.10` | Max single order as fraction of balance |
| `MAX_MARKET_EXPOSURE` | No | `0.30` | Max total exposure per market |
| `MAX_SLIPPAGE` | No | `0.02` | Skip order if price moved beyond this |
| `POLL_INTERVAL` | No | `5` | Seconds between wallet polls |
| `PRIVATE_KEY` | Live only | — | Signs EIP-712 orders locally |
| `FUNDER_ADDRESS` | Live only | — | Wallet address for CLOB |
| `RPC_URL` | Live only | — | Polygon JSON-RPC endpoint |
| `CLOB_API_KEY/SECRET/PASSPHRASE` | No | — | Skip to derive from private key |
| `DASHBOARD_PORT` | No | `3000` | |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | No | — | Both required for notifications |

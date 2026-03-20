import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import { DASHBOARD_PORT, WEBHOOK_PORT, PAPER_TRADING, TRACKED_WALLETS } from "./config";
import logger from "./logger";
import type { StatsCollector } from "./stats";
import type { TelegramNotifier } from "./telegram";

export function startDashboard(statsCollector: StatsCollector, telegram?: TelegramNotifier): void {
  // HTTPS server on WEBHOOK_PORT — serves both dashboard and Telegram webhook
  const certPath = path.resolve("webhook.pem");
  const keyPath = path.resolve("webhook.key");

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const sslOptions = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    };

    const server = https.createServer(sslOptions, (req, res) => {
      if (req.method === "POST" && req.url === "/telegram-webhook" && telegram) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", async () => {
          try {
            const data = JSON.parse(body);
            await telegram.handleWebhook(data);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(`Webhook parse error: ${msg}`);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }

      handleRequest(req, res, statsCollector);
    });

    server.listen(WEBHOOK_PORT, "0.0.0.0", () => {
      logger.info(`Dashboard + webhook running on https://0.0.0.0:${WEBHOOK_PORT}`);

      if (telegram) {
        const publicUrl = `https://${process.env.WEBHOOK_HOST || "34.244.45.20"}:${WEBHOOK_PORT}/telegram-webhook`;
        telegram.registerWebhook(publicUrl, certPath);
      }
    });
  } else {
    // Fallback to HTTP if no certs
    const server = http.createServer((req, res) => {
      handleRequest(req, res, statsCollector);
    });

    server.listen(DASHBOARD_PORT, "0.0.0.0", () => {
      logger.info(`Dashboard running on http://0.0.0.0:${DASHBOARD_PORT}`);
    });

    if (telegram) {
      logger.info("No webhook.pem/webhook.key found — Telegram commands disabled");
    }
  }
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, statsCollector: StatsCollector): void {
  if (req.url === "/api/stats") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(statsCollector.getStats()));
    return;
  }

  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(getHTML());
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}

function getHTML(): string {
  const mode = PAPER_TRADING ? "Paper" : "Live";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Polymarket Copy Bot</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0a0a0f; color: #e0e0e0; padding: 20px; }
  h1 { text-align: center; color: #00d4aa; margin-bottom: 8px; font-size: 1.6em; }
  .tracking { position: absolute; top: 20px; right: 20px; text-align: right; color: #555; font-size: 0.75em; line-height: 1.6; }
  .tracking span { color: #888; font-family: monospace; }
  .header { position: relative; }
  .subtitle { text-align: center; color: #666; margin-bottom: 20px; font-size: 0.9em; display: flex; align-items: center; justify-content: center; gap: 8px; }
  .mode-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
  .mode-dot.paper { background: #ffffff; }
  .mode-dot.live { background: #ff4466; animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; box-shadow: 0 0 4px #ff4466; } 50% { opacity: 0.4; box-shadow: 0 0 12px #ff4466; } }
  .day-selector { display: flex; justify-content: center; gap: 8px; margin-bottom: 24px; flex-wrap: wrap; }
  .day-btn { background: #14141f; border: 1px solid #2a2a3a; border-radius: 8px; padding: 8px 16px; color: #888; cursor: pointer; font-size: 0.85em; font-family: inherit; transition: all 0.2s; }
  .day-btn:hover { border-color: #00d4aa; color: #e0e0e0; }
  .day-btn.active { background: #00d4aa; color: #0a0a0f; border-color: #00d4aa; font-weight: bold; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #14141f; border: 1px solid #2a2a3a; border-radius: 10px; padding: 16px; text-align: center; }
  .card .label { color: #888; font-size: 0.75em; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .card .value { font-size: 1.5em; font-weight: bold; }
  .card .sub { color: #666; font-size: 0.7em; margin-top: 4px; }
  .green { color: #00d4aa; }
  .red { color: #ff4466; }
  .neutral { color: #e0e0e0; }
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
  .chart-box { background: #14141f; border: 1px solid #2a2a3a; border-radius: 10px; padding: 16px; }
  .chart-box h3 { color: #888; font-size: 0.85em; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 1px; }
  .positions { background: #14141f; border: 1px solid #2a2a3a; border-radius: 10px; padding: 16px; }
  .positions h3 { color: #888; font-size: 0.85em; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 1px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th { color: #666; text-align: left; padding: 8px; border-bottom: 1px solid #2a2a3a; font-weight: normal; text-transform: uppercase; font-size: 0.75em; letter-spacing: 1px; }
  td { padding: 8px; border-bottom: 1px solid #1a1a2a; }
  .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .dot-open { background: #00d4aa; }
  .dot-pending { background: #ffaa00; }
  .updated { text-align: center; color: #444; font-size: 0.75em; margin-top: 16px; }
  .no-data { text-align: center; color: #444; padding: 60px; font-size: 1.1em; }
  @media (max-width: 768px) { .charts { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="header">
<div class="tracking">Tracking:<br>${TRACKED_WALLETS.map(w => `<span>${w.slice(0, 6)}...${w.slice(-4)}</span>`).join("<br>")}</div>
<h1>Polymarket Copy Bot</h1>
<p class="subtitle"><span class="mode-dot ${PAPER_TRADING ? "paper" : "live"}"></span>${mode} Trading Dashboard</p>
</div>

<div id="content"><div class="no-data">Waiting for data...</div></div>

<script>
let portfolioChart = null;
let pnlChart = null;
let allStats = null;
let selectedDay = "all";

function fmt(n) { return n >= 0 ? '+$' + n.toFixed(2) : '-$' + Math.abs(n).toFixed(2); }
function fmtD(n) { return '$' + n.toFixed(2); }
function cls(n) { return n >= 0 ? 'green' : 'red'; }

function dateKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function dateName(key) {
  const d = new Date(key + 'T12:00:00');
  const today = dateKey(new Date().toISOString());
  const yesterday = dateKey(new Date(Date.now() - 86400000).toISOString());
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function getAvailableDays(history) {
  const days = new Set();
  for (const h of history) days.add(dateKey(h.timestamp));
  return Array.from(days).sort();
}

function filterByDay(history, day) {
  if (day === "all") return history;
  return history.filter(h => dateKey(h.timestamp) === day);
}

function getDayStats(history, day, startBalance) {
  const filtered = filterByDay(history, day);
  if (filtered.length === 0) return null;

  const last = filtered[filtered.length - 1];
  const first = filtered[0];

  if (day === "all") {
    return {
      portfolio: last.portfolio,
      overallPnL: last.overallPnL,
      realizedPnL: last.realizedPnL,
      cash: last.cash,
      wins: last.wins,
      losses: last.losses,
      winRate: last.winRate,
      openInvested: last.openInvested,
      openPnL: last.openPnL,
      pendingCost: last.pendingCost,
      pendingCount: last.pendingCount,
      positions: last.positions,
      timestamp: last.timestamp,
      dayRealizedPnL: null,
      dayWins: null,
      dayLosses: null,
      settlements: null,
      skippedMinSize: last.skippedMinSize || [],
    };
  }

  const dayRealizedPnL = last.realizedPnL - first.realizedPnL;
  const dayWins = last.wins - first.wins;
  const dayLosses = last.losses - first.losses;
  const daySettlements = dayWins + dayLosses;

  return {
    portfolio: last.portfolio,
    overallPnL: last.overallPnL,
    realizedPnL: last.realizedPnL,
    cash: last.cash,
    wins: last.wins,
    losses: last.losses,
    winRate: last.winRate,
    openInvested: last.openInvested,
    openPnL: last.openPnL,
    pendingCost: last.pendingCost,
    pendingCount: last.pendingCount,
    positions: last.positions,
    timestamp: last.timestamp,
    dayRealizedPnL: dayRealizedPnL,
    dayWins: dayWins,
    dayLosses: dayLosses,
    settlements: daySettlements,
    skippedMinSize: last.skippedMinSize || [],
  };
}

function createCharts(history) {
  const labels = history.map(h => {
    const d = new Date(h.timestamp);
    if (selectedDay === "all") {
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });

  const chartOpts = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#555', maxTicksLimit: 8 }, grid: { color: '#1a1a2a' } },
      y: { ticks: { color: '#555' }, grid: { color: '#1a1a2a' } }
    }
  };

  const pCtx = document.getElementById("portfolioChart").getContext("2d");
  if (portfolioChart) portfolioChart.destroy();
  portfolioChart = new Chart(pCtx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: history.map(h => h.portfolio),
        borderColor: '#00d4aa',
        backgroundColor: 'rgba(0,212,170,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 0
      }]
    },
    options: { ...chartOpts, scales: { ...chartOpts.scales, y: { ...chartOpts.scales.y, ticks: { ...chartOpts.scales.y.ticks, callback: v => '$' + v } } } }
  });

  const rCtx = document.getElementById("pnlChart").getContext("2d");
  if (pnlChart) pnlChart.destroy();
  pnlChart = new Chart(rCtx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: history.map(h => h.realizedPnL),
        borderColor: '#4488ff',
        backgroundColor: 'rgba(68,136,255,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 0
      }]
    },
    options: { ...chartOpts, scales: { ...chartOpts.scales, y: { ...chartOpts.scales.y, ticks: { ...chartOpts.scales.y.ticks, callback: v => '$' + v } } } }
  });
}

function selectDay(day) {
  selectedDay = day;
  if (allStats) renderWithStats(allStats);
}

function renderWithStats(stats) {
  if (!stats.current || stats.history.length === 0) {
    document.getElementById("content").innerHTML = '<div class="no-data">Waiting for first trade...</div>';
    return;
  }

  const days = getAvailableDays(stats.history);
  const filteredHistory = filterByDay(stats.history, selectedDay);
  const dayData = getDayStats(stats.history, selectedDay, stats.startBalance);
  if (!dayData) return;

  const isDay = selectedDay !== "all";
  const winTotal = isDay && dayData.dayWins !== null ? dayData.dayWins + dayData.dayLosses : dayData.wins + dayData.losses;
  const wins = isDay && dayData.dayWins !== null ? dayData.dayWins : dayData.wins;
  const losses = isDay && dayData.dayLosses !== null ? dayData.dayLosses : dayData.losses;
  const winRate = winTotal > 0 ? (wins / winTotal) * 100 : 0;
  const winRateText = winTotal > 0 ? winRate.toFixed(0) + '% (' + wins + 'W/' + losses + 'L)' : 'N/A';

  // Day selector
  let html = '<div class="day-selector">';
  html += '<button class="day-btn' + (selectedDay === "all" ? ' active' : '') + '" onclick="selectDay(&quot;all&quot;)">All</button>';
  for (const day of days) {
    html += '<button class="day-btn' + (selectedDay === day ? ' active' : '') + '" onclick="selectDay(&quot;' + day + '&quot;)">' + dateName(day) + '</button>';
  }
  html += '</div>';

  // Cards
  html += '<div class="cards">';
  html += '<div class="card"><div class="label">Portfolio</div><div class="value ' + cls(dayData.overallPnL) + '">' + fmtD(dayData.portfolio) + '</div></div>';
  html += '<div class="card"><div class="label">Overall P&L</div><div class="value ' + cls(dayData.overallPnL) + '">' + fmt(dayData.overallPnL) + '</div></div>';

  if (isDay && dayData.dayRealizedPnL !== null) {
    html += '<div class="card"><div class="label">Day Realized P&L</div><div class="value ' + cls(dayData.dayRealizedPnL) + '">' + fmt(dayData.dayRealizedPnL) + '</div><div class="sub">Total: ' + fmt(dayData.realizedPnL) + '</div></div>';
  } else {
    html += '<div class="card"><div class="label">Realized P&L</div><div class="value ' + cls(dayData.realizedPnL) + '">' + fmt(dayData.realizedPnL) + '</div></div>';
  }

  html += '<div class="card"><div class="label">Cash</div><div class="value neutral">' + fmtD(dayData.cash) + '</div></div>';
  html += '<div class="card"><div class="label">Win Rate' + (isDay ? ' (Day)' : '') + '</div><div class="value ' + (winRate >= 50 ? 'green' : 'red') + '">' + winRateText + '</div></div>';

  if (isDay && dayData.settlements !== null) {
    html += '<div class="card"><div class="label">Day Settlements</div><div class="value neutral">' + dayData.settlements + '</div></div>';
  }

  html += '<div class="card"><div class="label">Open Positions</div><div class="value neutral">' + fmtD(dayData.openInvested) + '</div></div>';
  html += '<div class="card"><div class="label">Unrealized P&L</div><div class="value ' + cls(dayData.openPnL) + '">' + fmt(dayData.openPnL) + '</div></div>';
  if (dayData.pendingCount > 0) {
    html += '<div class="card"><div class="label">Pending (' + dayData.pendingCount + ' markets)</div><div class="value neutral">' + fmtD(dayData.pendingCost) + '</div></div>';
  }
  html += '</div>';

  // Charts
  html += '<div class="charts">';
  html += '<div class="chart-box"><h3>Portfolio Value' + (isDay ? ' (' + dateName(selectedDay) + ')' : '') + '</h3><div style="height:250px"><canvas id="portfolioChart"></canvas></div></div>';
  html += '<div class="chart-box"><h3>Realized P&L' + (isDay ? ' (' + dateName(selectedDay) + ')' : '') + '</h3><div style="height:250px"><canvas id="pnlChart"></canvas></div></div>';
  html += '</div>';

  // Positions table (sorted by size descending)
  if (dayData.positions && dayData.positions.length > 0) {
    const sortedPositions = [...dayData.positions].sort((a, b) => b.size - a.size);
    html += '<div class="positions"><h3>Current Positions</h3><table><tr><th>Status</th><th>Market</th><th>Size</th><th>Entry</th><th>Current</th><th>P&L</th></tr>';
    for (const p of sortedPositions) {
      const status = p.pending ? '<span class="status-dot dot-pending"></span>Pending' : '<span class="status-dot dot-open"></span>Open';
      const current = p.currentPrice !== null ? '$' + p.currentPrice.toFixed(4) : '---';
      const pnl = p.pnl !== null ? fmt(p.pnl) : '---';
      const pnlClass = p.pnl !== null ? cls(p.pnl) : 'neutral';
      html += '<tr><td>' + status + '</td><td>' + p.title + ' [' + p.outcome + ']</td><td>' + p.size.toFixed(2) + '</td><td>$' + p.avgPrice.toFixed(4) + '</td><td>' + current + '</td><td class="' + pnlClass + '">' + pnl + '</td></tr>';
    }
    html += '</table></div>';
  }

  // Skipped trades section (min 5 token size)
  const skipped = dayData.skippedMinSize || [];
  if (skipped.length > 0) {
    html += '<div class="positions" style="margin-top: 16px;"><h3>Skipped Trades (Below 5 Token Minimum) — ' + skipped.length + ' total</h3><table><tr><th>Time</th><th>Side</th><th>Market</th><th>Calculated Size</th><th>Price</th><th>Would Cost</th></tr>';
    for (const s of skipped.slice(-50).reverse()) {
      const time = new Date(s.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const cost = (s.calculatedSize * s.price).toFixed(2);
      html += '<tr><td>' + time + '</td><td>' + s.side + '</td><td>' + s.title + ' [' + s.outcome + ']</td><td class="red">' + s.calculatedSize.toFixed(2) + ' / 5.00</td><td>$' + s.price.toFixed(4) + '</td><td>$' + cost + '</td></tr>';
    }
    html += '</table></div>';
  }

  html += '<div class="updated">Last updated: ' + new Date(dayData.timestamp).toLocaleString() + ' | Auto-refreshes every 60s</div>';

  document.getElementById("content").innerHTML = html;
  if (filteredHistory.length > 1) createCharts(filteredHistory);
}

function render(stats) {
  allStats = stats;
  renderWithStats(stats);
}

async function refresh() {
  try {
    const res = await fetch("/api/stats");
    const stats = await res.json();
    render(stats);
  } catch {}
}

refresh();
setInterval(refresh, 60000);
</script>
</body>
</html>`;
}

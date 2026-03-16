import http from "http";
import { DASHBOARD_PORT } from "./config";
import logger from "./logger";
import type { StatsCollector } from "./stats";

export function startDashboard(statsCollector: StatsCollector): void {
  const server = http.createServer((req, res) => {
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
  });

  server.listen(DASHBOARD_PORT, "0.0.0.0", () => {
    logger.info(`Dashboard running on http://0.0.0.0:${DASHBOARD_PORT}`);
  });
}

function getHTML(): string {
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
  .subtitle { text-align: center; color: #666; margin-bottom: 24px; font-size: 0.9em; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #14141f; border: 1px solid #2a2a3a; border-radius: 10px; padding: 16px; text-align: center; }
  .card .label { color: #888; font-size: 0.75em; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .card .value { font-size: 1.5em; font-weight: bold; }
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
<h1>Polymarket Copy Bot</h1>
<p class="subtitle">Paper Trading Dashboard</p>

<div id="content"><div class="no-data">Waiting for data...</div></div>

<script>
let portfolioChart = null;
let pnlChart = null;

function fmt(n) { return n >= 0 ? '+$' + n.toFixed(2) : '-$' + Math.abs(n).toFixed(2); }
function fmtD(n) { return '$' + n.toFixed(2); }
function cls(n) { return n >= 0 ? 'green' : 'red'; }

function createCharts(history) {
  const labels = history.map(h => {
    const d = new Date(h.timestamp);
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

  const pCtx = document.getElementById('portfolioChart').getContext('2d');
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

  const rCtx = document.getElementById('pnlChart').getContext('2d');
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

function render(stats) {
  const c = stats.current;
  if (!c) { document.getElementById('content').innerHTML = '<div class="no-data">Waiting for first trade...</div>'; return; }

  const winTotal = c.wins + c.losses;
  const winRateText = winTotal > 0 ? c.winRate.toFixed(0) + '% (' + c.wins + 'W/' + c.losses + 'L)' : 'N/A';

  let html = '<div class="cards">';
  html += '<div class="card"><div class="label">Portfolio</div><div class="value ' + cls(c.overallPnL) + '">' + fmtD(c.portfolio) + '</div></div>';
  html += '<div class="card"><div class="label">Overall P&L</div><div class="value ' + cls(c.overallPnL) + '">' + fmt(c.overallPnL) + '</div></div>';
  html += '<div class="card"><div class="label">Realized P&L</div><div class="value ' + cls(c.realizedPnL) + '">' + fmt(c.realizedPnL) + '</div></div>';
  html += '<div class="card"><div class="label">Cash</div><div class="value neutral">' + fmtD(c.cash) + '</div></div>';
  html += '<div class="card"><div class="label">Win Rate</div><div class="value ' + (c.winRate >= 50 ? 'green' : 'red') + '">' + winRateText + '</div></div>';
  html += '<div class="card"><div class="label">Open Positions</div><div class="value neutral">' + fmtD(c.openInvested) + '</div></div>';
  html += '<div class="card"><div class="label">Unrealized P&L</div><div class="value ' + cls(c.openPnL) + '">' + fmt(c.openPnL) + '</div></div>';
  if (c.pendingCount > 0) {
    html += '<div class="card"><div class="label">Pending (' + c.pendingCount + ' markets)</div><div class="value neutral">' + fmtD(c.pendingCost) + '</div></div>';
  }
  html += '</div>';

  html += '<div class="charts">';
  html += '<div class="chart-box"><h3>Portfolio Value</h3><div style="height:250px"><canvas id="portfolioChart"></canvas></div></div>';
  html += '<div class="chart-box"><h3>Realized P&L</h3><div style="height:250px"><canvas id="pnlChart"></canvas></div></div>';
  html += '</div>';

  if (c.positions.length > 0) {
    html += '<div class="positions"><h3>Positions</h3><table><tr><th>Status</th><th>Market</th><th>Size</th><th>Entry</th><th>Current</th><th>P&L</th></tr>';
    for (const p of c.positions) {
      const status = p.pending ? '<span class="status-dot dot-pending"></span>Pending' : '<span class="status-dot dot-open"></span>Open';
      const current = p.currentPrice !== null ? '$' + p.currentPrice.toFixed(4) : '—';
      const pnl = p.pnl !== null ? fmt(p.pnl) : '—';
      const pnlClass = p.pnl !== null ? cls(p.pnl) : 'neutral';
      html += '<tr><td>' + status + '</td><td>' + p.title + ' [' + p.outcome + ']</td><td>' + p.size.toFixed(2) + '</td><td>$' + p.avgPrice.toFixed(4) + '</td><td>' + current + '</td><td class="' + pnlClass + '">' + pnl + '</td></tr>';
    }
    html += '</table></div>';
  }

  html += '<div class="updated">Last updated: ' + new Date(c.timestamp).toLocaleString() + ' | Auto-refreshes every 60s</div>';

  document.getElementById('content').innerHTML = html;
  if (stats.history.length > 1) createCharts(stats.history);
}

async function refresh() {
  try {
    const res = await fetch('/api/stats');
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

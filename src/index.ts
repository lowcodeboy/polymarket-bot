import { CopyTradingBot } from "./bot";
import { startDashboard } from "./dashboard";

const bot = new CopyTradingBot();

// Start dashboard
startDashboard(bot.getStatsCollector());

process.on("SIGINT", () => {
  bot.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bot.stop();
  process.exit(0);
});

bot.start().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

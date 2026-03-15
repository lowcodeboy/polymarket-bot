import { CopyTradingBot } from "./bot";

const bot = new CopyTradingBot();

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

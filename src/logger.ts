import winston from "winston";
import { PAPER_TRADING, LOG_LEVEL } from "./config";

const modeLabel = PAPER_TRADING ? "PAPER" : "LIVE";

const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp as string} [${modeLabel}] ${level.toUpperCase()} ${message as string}`;
    }),
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: "bot.log",
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});

export default logger;

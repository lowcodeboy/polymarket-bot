import {
  TRADE_MULTIPLIER,
  MAX_POSITION_PCT,
  MAX_SLIPPAGE,
} from "./config";
import logger from "./logger";
import type { DetectedTrade, BotOrder } from "./types";

export class PositionSizer {
  calculate(
    trade: DetectedTrade,
    myBalance: number,
    traderValue: number,
  ): BotOrder | null {
    if (trade.price <= 0 || trade.price >= 1) {
      logger.debug(
        `Skipping trade: price ${trade.price} out of range (0, 1)`,
      );
      return null;
    }

    let usdcAmount: number;
    if (traderValue > 0) {
      usdcAmount =
        (trade.usdcSize / traderValue) * myBalance * TRADE_MULTIPLIER;
    } else {
      usdcAmount = trade.usdcSize * TRADE_MULTIPLIER;
    }

    // Cap at MAX_POSITION_PCT of balance
    const maxAllowed = myBalance * MAX_POSITION_PCT;
    if (usdcAmount > maxAllowed) {
      usdcAmount = maxAllowed;
    }

    // Skip tiny trades
    if (usdcAmount < 0.5) {
      logger.debug(`Skipping trade: usdcAmount $${usdcAmount.toFixed(2)} < $0.50`);
      return null;
    }

    // Skip if BUY and insufficient balance
    if (trade.side === "BUY" && usdcAmount > myBalance) {
      logger.debug(`Skipping trade: usdcAmount $${usdcAmount.toFixed(2)} > balance $${myBalance.toFixed(2)}`);
      return null;
    }

    const size = usdcAmount / trade.price;

    return {
      tokenId: trade.tokenId,
      side: trade.side,
      price: trade.price,
      size,
      usdcAmount,
      conditionId: trade.conditionId,
      title: trade.title,
      outcome: trade.outcome,
      sourceWallet: trade.wallet,
      sourceTrade: trade,
    };
  }

  isWithinSlippage(orderPrice: number, currentPrice: number): boolean {
    if (orderPrice <= 0) return false;
    const diff = Math.abs(currentPrice - orderPrice) / orderPrice;
    return diff <= MAX_SLIPPAGE;
  }
}

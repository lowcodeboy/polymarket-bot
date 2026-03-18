import {
  TRADE_MULTIPLIER,
  MAX_POSITION_PCT,
  MAX_SLIPPAGE,
  MAX_MARKET_EXPOSURE,
  PAPER_BALANCE,
} from "./config";
import logger from "./logger";
import type { DetectedTrade, BotOrder, PaperPosition } from "./types";

export class PositionSizer {
  calculate(
    trade: DetectedTrade,
    myBalance: number,
    traderValue: number,
    positions: Record<string, PaperPosition>,
  ): BotOrder | null {
    if (trade.price <= 0 || trade.price >= 1) {
      logger.debug(
        `Skipping trade: price ${trade.price} out of range (0, 1)`,
      );
      return null;
    }

    // Check existing exposure to this market
    if (trade.side === "BUY") {
      const posKey = `${trade.conditionId}:${trade.outcome}`;
      const existing = positions[posKey];
      const currentExposure = existing ? existing.size * existing.avgPrice : 0;
      const maxExposure = PAPER_BALANCE * MAX_MARKET_EXPOSURE;

      if (currentExposure >= maxExposure) {
        logger.debug(
          `Skipping trade: market exposure $${currentExposure.toFixed(2)} already at cap $${maxExposure.toFixed(2)} (${(MAX_MARKET_EXPOSURE * 100).toFixed(0)}%)`,
        );
        return null;
      }
    }

    let usdcAmount: number;
    if (traderValue > 0) {
      usdcAmount =
        (trade.usdcSize / traderValue) * myBalance * TRADE_MULTIPLIER;
    } else {
      usdcAmount = trade.usdcSize * TRADE_MULTIPLIER;
    }

    // Cap at MAX_POSITION_PCT of balance (per order)
    const maxAllowed = myBalance * MAX_POSITION_PCT;
    if (usdcAmount > maxAllowed) {
      usdcAmount = maxAllowed;
    }

    // Cap to not exceed MAX_MARKET_EXPOSURE (total position)
    if (trade.side === "BUY") {
      const posKey = `${trade.conditionId}:${trade.outcome}`;
      const existing = positions[posKey];
      const currentExposure = existing ? existing.size * existing.avgPrice : 0;
      const maxExposure = PAPER_BALANCE * MAX_MARKET_EXPOSURE;
      const roomLeft = maxExposure - currentExposure;

      if (roomLeft <= 0) return null;
      if (usdcAmount > roomLeft) {
        usdcAmount = roomLeft;
      }
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

    const MIN_ORDER_SIZE = 5;
    let size = usdcAmount / trade.price;

    // Ensure minimum 5 tokens: add 5 to trades below the minimum to preserve
    // relative sizing while meeting Polymarket's minimum order requirement
    if (size < MIN_ORDER_SIZE) {
      size = MIN_ORDER_SIZE + size;
      usdcAmount = size * trade.price;

      // Re-check balance after adjustment
      if (trade.side === "BUY" && usdcAmount > myBalance) {
        logger.debug(`Skipping trade: adjusted size ${size.toFixed(2)} tokens ($${usdcAmount.toFixed(2)}) exceeds balance $${myBalance.toFixed(2)}`);
        return null;
      }
    }

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

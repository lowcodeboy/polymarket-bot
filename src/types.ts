export interface DetectedTrade {
  wallet: string;
  timestamp: string;
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  usdcSize: number;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  transactionHash: string;
}

export interface BotOrder {
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  usdcAmount: number;
  conditionId: string;
  title: string;
  outcome: string;
  sourceWallet: string;
  sourceTrade: DetectedTrade;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  filledSize?: number;
  filledPrice?: number;
  error?: string;
  paper: boolean;
}

export interface PaperPosition {
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  size: number;
  avgPrice: number;
  title: string;
  outcome: string;
  currentPrice?: number;
}

export interface PaperTradeRecord {
  timestamp: string;
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  usdcAmount: number;
  title: string;
  outcome: string;
  balanceAfter: number;
}

export interface PaperPortfolio {
  balance: number;
  positions: Record<string, PaperPosition>;
  totalTrades: number;
  totalPnL: number;
  settlementWins: number;
  settlementLosses: number;
  tradeHistory: PaperTradeRecord[];
}

export interface SettlementResult {
  title: string;
  outcome: string;
  won: boolean;
  tokens: number;
  payout: number;
  pnl: number;
}

export interface TradingEngine {
  execute(order: BotOrder): Promise<OrderResult>;
  getBalance(): Promise<number>;
  getPositions(): Record<string, PaperPosition>;
  getRealizedPnL(): number;
  getWinRate(): { wins: number; losses: number; rate: number };
  settleResolvedMarkets(): Promise<SettlementResult[]>;
}

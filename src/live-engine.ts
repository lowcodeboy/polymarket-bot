import { Wallet } from "@ethersproject/wallet";
import axios from "axios";
import {
  ClobClient,
  type ApiKeyCreds,
  SignatureType,
  Side,
} from "@polymarket/clob-client";
import {
  PRIVATE_KEY,
  FUNDER_ADDRESS,
  CLOB_HOST,
  CHAIN_ID,
  SIGNATURE_TYPE,
  DATA_API,
  GAMMA_API,
} from "./config";
import logger from "./logger";
import type { BotOrder, OrderResult, PaperPosition, TradingEngine } from "./types";

const HTTP_TIMEOUT = 10_000;

function toSignatureType(n: number): SignatureType {
  if (n === 1) return SignatureType.POLY_PROXY;
  if (n === 2) return SignatureType.POLY_GNOSIS_SAFE;
  return SignatureType.EOA;
}

export class LiveTradingEngine implements TradingEngine {
  private client: ClobClient | null = null;

  async initialize(): Promise<void> {
    logger.info("Initializing live trading engine...");

    // Key stays in memory, never transmitted — used only for local EIP-712 signing
    const wallet = new Wallet(PRIVATE_KEY);
    logger.info(`Signer address: ${wallet.address}`);

    // Derive API credentials via standard Polymarket flow
    const tempClient = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      wallet,
      undefined,
      toSignatureType(SIGNATURE_TYPE),
      FUNDER_ADDRESS,
    );

    const creds: ApiKeyCreds = await tempClient.createOrDeriveApiKey();
    logger.info("API credentials derived successfully");

    this.client = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      wallet,
      creds,
      toSignatureType(SIGNATURE_TYPE),
      FUNDER_ADDRESS,
    );

    logger.info("Live trading engine initialized");
  }

  async execute(order: BotOrder): Promise<OrderResult> {
    if (!this.client) {
      return { success: false, error: "Live engine not initialized", paper: false };
    }

    try {
      // Fetch market metadata for tickSize and negRisk
      const marketResp = await axios.get(`${GAMMA_API}/markets`, {
        params: { clob_token_ids: order.tokenId },
        timeout: HTTP_TIMEOUT,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const markets: any[] = marketResp.data;
      const market = Array.isArray(markets) ? markets[0] : null;

      const tickSize = market?.minimum_tick_size ?? "0.01";
      const negRisk = market?.neg_risk ?? false;

      const side = order.side === "BUY" ? Side.BUY : Side.SELL;

      const result = await this.client.createAndPostOrder(
        {
          tokenID: order.tokenId,
          price: order.price,
          size: order.size,
          side,
        },
        { tickSize, negRisk },
      );

      const orderId =
        result?.orderID ?? result?.orderIds?.[0] ?? result?.id ?? "unknown";

      logger.info(
        `Live order placed: ${orderId} | ${order.side} ${order.size.toFixed(4)} @ $${order.price.toFixed(4)}`,
      );

      return {
        success: true,
        orderId,
        filledSize: order.size,
        filledPrice: order.price,
        paper: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Live order failed: ${msg}`);
      return { success: false, error: msg, paper: false };
    }
  }

  getPositions(): Record<string, PaperPosition> {
    return {};
  }

  async getBalance(): Promise<number> {
    try {
      const resp = await axios.get(`${DATA_API}/value`, {
        params: { user: FUNDER_ADDRESS },
        timeout: HTTP_TIMEOUT,
      });
      const val = parseFloat(resp.data?.value ?? resp.data ?? "0");
      return isNaN(val) ? 0 : val;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to get live balance: ${msg}`);
      return 0;
    }
  }
}

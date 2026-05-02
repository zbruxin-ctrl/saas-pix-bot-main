// pricingClient.ts — consulta pricing/volume tiers na API
import axios from 'axios';

const API_URL = process.env.API_URL!;
const BOT_SECRET = process.env.BOT_SECRET!;

export interface PricingResult {
  productId: string;
  productName: string;
  unitPrice: number;
  qty: number;
  originalAmount: number;
  finalAmount: number;
  discountPercent: number;
  tierId: string | null;
}

export async function getProductPricing(
  productId: string,
  qty: number = 1
): Promise<PricingResult> {
  const { data } = await axios.get(`${API_URL}/pricing`, {
    params: { productId, qty },
    headers: { 'x-bot-secret': BOT_SECRET },
  });
  return data.data as PricingResult;
}

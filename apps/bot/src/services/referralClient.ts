// referralClient.ts — client do bot para o programa de indicação
// FIX #3: usa env validado em vez de process.env direto
import axios from 'axios';
import { env } from '../config/env';

export interface ReferralStats {
  totalReferred: number;
  totalConverted: number;
  totalEarned: number;
  referrals: {
    id: string;
    name: string;
    rewardPaid: boolean;
    rewardAmount: number;
    createdAt: string;
  }[];
}

export async function registerReferral(
  referrerTelegramId: string,
  referredTelegramId: string
): Promise<{ success: boolean; reason?: string }> {
  try {
    const { data } = await axios.post(
      `${env.API_URL}/api/referrals/register`,
      { referrerTelegramId, referredTelegramId },
      { headers: { 'x-bot-secret': env.TELEGRAM_BOT_SECRET } }
    );
    return { success: data.success, reason: data.reason };
  } catch {
    return { success: false };
  }
}

export async function getReferralStats(telegramId: string): Promise<ReferralStats> {
  const { data } = await axios.get(`${env.API_URL}/api/referrals/stats`, {
    params: { telegramId },
    headers: { 'x-bot-secret': env.TELEGRAM_BOT_SECRET },
  });
  return data.data as ReferralStats;
}

// referralClient.ts — client do bot para o programa de indicação
import axios from 'axios';

const API_URL = process.env.API_URL!;
const BOT_SECRET = process.env.BOT_SECRET!;

export interface ReferralStats {
  totalReferred: number;
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
      `${API_URL}/referrals/register`,
      { referrerTelegramId, referredTelegramId },
      { headers: { 'x-bot-secret': BOT_SECRET } }
    );
    return { success: data.success, reason: data.reason };
  } catch {
    return { success: false };
  }
}

export async function getReferralStats(telegramId: string): Promise<ReferralStats> {
  const { data } = await axios.get(`${API_URL}/referrals/stats`, {
    params: { telegramId },
    headers: { 'x-bot-secret': BOT_SECRET },
  });
  return data.data as ReferralStats;
}

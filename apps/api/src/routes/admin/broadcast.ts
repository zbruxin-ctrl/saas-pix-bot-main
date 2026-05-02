// routes/admin/broadcast.ts
// FEAT #6: Broadcast de mensagens — enviar mensagem para todos os usuarios ativos
// POST /api/admin/broadcast
// Requer SUPERADMIN. Executa em background (não trava o request).
// FIX: lê TELEGRAM_BOT_TOKEN (padrão da API) em vez de BOT_TOKEN
import { Router, Response } from 'express';
import { z } from 'zod';
import { Telegraf } from 'telegraf';
import { prisma } from '../../lib/prisma';
import { requireRole, AuthenticatedRequest } from '../../middleware/auth';
import { logger } from '../../lib/logger';
import { env } from '../../config/env';

export const broadcastRouter = Router();

// Instancia Telegraf apenas para envio HTTP — sem iniciar polling/webhook
function getTelegraf(): Telegraf {
  // Usa env.TELEGRAM_BOT_TOKEN (já validado no startup da API)
  return new Telegraf(env.TELEGRAM_BOT_TOKEN);
}

const broadcastSchema = z.object({
  message: z.string().min(1).max(4096),
  // Se true: envia somente para quem tem isBlocked=false e pelo menos 1 pedido
  onlyActiveUsers: z.boolean().default(true),
  // Parse_mode: MarkdownV2 ou HTML (opção avançada, default HTML)
  parseMode: z.enum(['HTML', 'MarkdownV2', 'Markdown']).default('HTML'),
});

/**
 * POST /api/admin/broadcast
 * Body: { message: string, onlyActiveUsers?: boolean, parseMode?: string }
 * Retorna imediatamente com jobId e processa em background.
 */
broadcastRouter.post(
  '/',
  requireRole('SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const { message, onlyActiveUsers, parseMode } = broadcastSchema.parse(req.body);

    const where = onlyActiveUsers
      ? { isBlocked: false, orders: { some: {} } }
      : { isBlocked: false };

    const users = await prisma.telegramUser.findMany({
      where,
      select: { telegramId: true },
    });

    if (users.length === 0) {
      res.json({ success: true, sent: 0, failed: 0, total: 0 });
      return;
    }

    const jobId = `broadcast_${Date.now()}`;
    logger.info(`[broadcast] jobId=${jobId} total=${users.length} admin=${req.admin?.id}`);

    // Responde imediatamente
    res.json({ success: true, jobId, total: users.length, status: 'queued' });

    // Processa em background com throttle de ~25 msg/s (limite Telegram: 30/s global)
    setImmediate(async () => {
      let sent = 0;
      let failed = 0;
      const BATCH = 25;
      const DELAY_MS = 1100;

      const tg = getTelegraf();

      for (let i = 0; i < users.length; i += BATCH) {
        const batch = users.slice(i, i + BATCH);
        await Promise.allSettled(
          batch.map(async (u) => {
            try {
              await tg.telegram.sendMessage(u.telegramId, message, {
                parse_mode: parseMode as any,
              });
              sent++;
            } catch (err: any) {
              // Ignora usuarios que bloquearam o bot (403)
              if (err?.response?.error_code !== 403) {
                logger.warn(`[broadcast] falha para telegramId=${u.telegramId}: ${err?.message}`);
              }
              failed++;
            }
          })
        );
        if (i + BATCH < users.length) {
          await new Promise((r) => setTimeout(r, DELAY_MS));
        }
      }

      logger.info(`[broadcast] jobId=${jobId} concluido: sent=${sent} failed=${failed}`);
    });
  }
);

// Rota que recebe updates do Telegram via webhook e repassa para o bot processar.
// O Telegram bate nesta rota (POST /telegram-webhook) na API pública.
// A API valida o secret_token e chama o handler registrado pelo bot.

import { Router, Request, Response } from 'express';
import { getBotHandler } from '../lib/botHandler';
import { env } from '../config/env';

export const telegramRouter = Router();

telegramRouter.post('/', async (req: Request, res: Response) => {
  const secretToken = req.headers['x-telegram-bot-api-secret-token'];
  if (env.TELEGRAM_BOT_SECRET && secretToken !== env.TELEGRAM_BOT_SECRET) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const handler = getBotHandler();
  if (!handler) {
    // Bot ainda não registrou o handler — responde 200 para o Telegram não retentar
    res.sendStatus(200);
    return;
  }

  try {
    await handler(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error('[telegram-webhook] Erro ao processar update:', err);
    res.sendStatus(200);
  }
});

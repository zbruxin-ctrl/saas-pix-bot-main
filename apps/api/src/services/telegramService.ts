// Serviço de integração com Telegram Bot API
// FIX-MD1: sendMessage com fallback para texto puro quando Telegram retorna 400
//          (Markdown inválido por conteúdo dos StockItems com caracteres especiais)
import axios from 'axios';
import { logger } from '../lib/logger';
import { env } from '../config/env';

const TELEGRAM_API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

interface SendMessageOptions {
  parse_mode?: string;
  reply_markup?: object;
  [key: string]: unknown;
}

/** Remove formatação Markdown para fallback em texto puro */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\_([^_]+)\_/g, '$1')
    .replace(/\`([^`]+)\`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

class TelegramService {

  async sendMessage(chatId: string, text: string, options?: SendMessageOptions): Promise<void> {
    try {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        ...(options ?? {}),
      });
    } catch (err: any) {
      // FIX-MD1: Telegram retorna 400 quando o Markdown é inválido
      // (ex: backticks, asteriscos ou underscores não fechados no conteúdo dos itens)
      // Fallback: reenvia sem parse_mode em texto puro
      const status = err?.response?.status;
      if (status === 400) {
        logger.warn(`[TelegramService] sendMessage 400 (Markdown inválido) — reenviando como texto puro | chat=${chatId}`);
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: stripMarkdown(text),
          ...(options ?? {}),
          parse_mode: undefined,
        });
        return;
      }
      throw err;
    }
  }

  // Envia imagem; se a URL falhar, envia como link de texto
  async sendPhoto(chatId: string, photoUrl: string, caption?: string): Promise<void> {
    try {
      await axios.post(`${TELEGRAM_API}/sendPhoto`, {
        chat_id: chatId,
        photo: photoUrl,
        caption: caption ?? undefined,
        parse_mode: 'Markdown',
      });
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 400) {
        logger.warn(`[TelegramService] sendPhoto 400 — reenviando como link de texto | chat=${chatId}`);
        const msg = caption ? `${stripMarkdown(caption)}\n\uD83D\uDCF7 ${photoUrl}` : `\uD83D\uDCF7 ${photoUrl}`;
        await this.sendMessage(chatId, msg, { parse_mode: undefined } as any);
        return;
      }
      logger.warn(`sendPhoto falhou para ${photoUrl}, enviando como link:`, err);
      const msg = caption ? `${caption}\n\uD83D\uDCF7 ${photoUrl}` : `\uD83D\uDCF7 ${photoUrl}`;
      await this.sendMessage(chatId, msg);
    }
  }

  // Envia vídeo via URL direta (MP4) ou link — Telegram faz player embutido para MP4 direto
  async sendVideo(chatId: string, videoUrl: string, caption?: string): Promise<void> {
    const isDirectMp4 = /\.(mp4)(\?|$)/i.test(videoUrl);

    if (isDirectMp4) {
      try {
        await axios.post(`${TELEGRAM_API}/sendVideo`, {
          chat_id: chatId,
          video: videoUrl,
          caption: caption ?? undefined,
          parse_mode: 'Markdown',
          supports_streaming: true,
        });
        return;
      } catch (err) {
        logger.warn(`sendVideo falhou para ${videoUrl}, enviando como link:`, err);
      }
    }

    // YouTube ou outros — envia como link clicável
    const label = caption ? `${caption}\n` : '';
    const msg = `${label}\uD83C\uDFAC [Assistir vídeo](${videoUrl})`;
    await this.sendMessage(chatId, msg);
  }

  async sendPaymentConfirmation(chatId: string, productName: string, amount: number): Promise<void> {
    const msg =
      `\u2705 *Pagamento confirmado!*\n\n` +
      `\uD83D\uDCE6 *Produto:* ${productName}\n` +
      `\uD83D\uDCB0 *Valor:* R$ ${amount.toFixed(2)}\n\n` +
      `Obrigado pela sua compra! \uD83D\uDE4F`;
    await this.sendMessage(chatId, msg);
  }

  async sendDeliveryError(chatId: string): Promise<void> {
    const msg =
      `\u26A0\uFE0F *Problema na entrega*\n\n` +
      `Identificamos um problema ao entregar seu pedido.\n` +
      `Nossa equipe foi notificada e entrará em contato em breve.`;
    await this.sendMessage(chatId, msg);
  }
}

export const telegramService = new TelegramService();

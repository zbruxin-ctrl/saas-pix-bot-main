// Serviço para envio de mensagens via Telegram Bot API
import axios from 'axios';
import FormData from 'form-data';
import { env } from '../config/env';
import { logger } from '../lib/logger';

const TELEGRAM_API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

class TelegramService {

  // Envia mensagem de texto (suporta Markdown)
  async sendMessage(
    chatId: string,
    text: string,
    options: Record<string, unknown> = {}
  ): Promise<void> {
    try {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        ...options,
      });
    } catch (error) {
      logger.error(`Falha ao enviar mensagem para ${chatId}:`, error);
      throw new Error('Não foi possível enviar mensagem no Telegram');
    }
  }

  // Envia imagem (QR code base64)
  async sendPhoto(
    chatId: string,
    photoBase64: string,
    caption?: string
  ): Promise<void> {
    try {
      // Converte base64 para buffer para enviar como arquivo
      const photoBuffer = Buffer.from(photoBase64, 'base64');

      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('photo', photoBuffer, {
        filename: 'qrcode.png',
        contentType: 'image/png',
      });
      if (caption) {
        form.append('caption', caption);
        form.append('parse_mode', 'Markdown');
      }

      await axios.post(`${TELEGRAM_API}/sendPhoto`, form, {
        headers: form.getHeaders(),
      });
    } catch (error) {
      logger.error(`Falha ao enviar foto para ${chatId}:`, error);
      // Não lança erro para não quebrar o fluxo
    }
  }

  // Mensagem de confirmação de pagamento (enviada pelo webhook)
  async sendPaymentConfirmation(
    chatId: string,
    productName: string,
    amount: number
  ): Promise<void> {
    const message =
      `✅ *Pagamento confirmado!*\n\n` +
      `💰 Valor: R$ ${amount.toFixed(2)}\n` +
      `📦 Produto: ${productName}\n\n` +
      `Aguarde um instante enquanto preparamos seu acesso... ⚙️`;

    await this.sendMessage(chatId, message);
  }

  // Mensagem de erro na entrega
  async sendDeliveryError(chatId: string): Promise<void> {
    const message =
      `⚠️ *Atenção!*\n\n` +
      `Seu pagamento foi confirmado, mas tivemos um problema ao liberar seu acesso.\n\n` +
      `Nossa equipe foi notificada e entrará em contato em breve. Pedimos desculpas pelo inconveniente.\n\n` +
      `Em caso de urgência, entre em contato conosco.`;

    await this.sendMessage(chatId, message);
  }
}

export const telegramService = new TelegramService();

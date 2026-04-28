// deliveryService.ts
// FEAT: mensagem de confirmaçao customizável via product.metadata.confirmationMessage
//       Variáveis: {{produto}}, {{conteudo}}
// FIX:  primeira mídia é enviada com a mensagem como caption (acoplada).
//       Se a mensagem ultrapassar 1024 chars (limite do Telegram),
//       envia o texto separado primeiro e depois as mídias normalmente.
// OPT #10: timeout de 30s em deliveryService.deliver via Promise.race
import { DeliveryType, TelegramUser, Product } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { telegramService } from './telegramService';
import { stockService } from './stockService';
import { logger } from '../lib/logger';

const MAX_RETRIES = 3;
const BASE_RETRY_MS = 3000;
const MAX_RETRY_MS = 15000;
const DELIVERY_TIMEOUT_MS = 30_000; // OPT #10

/** Limite de caption do Telegram */
const TELEGRAM_CAPTION_LIMIT = 1024;

type MediaEntry = {
  url: string;
  mediaType: 'IMAGE' | 'VIDEO' | 'FILE';
  caption?: string;
};

/** Monta a mensagem de entrega — aplica template customizado ou retorna fallback padrão */
function buildConfirmationMessage(
  product: Product,
  content: string,
  deliveryType: DeliveryType
): string {
  const meta = product.metadata as Record<string, unknown> | null;
  const custom = meta?.confirmationMessage as string | undefined;

  if (custom && custom.trim()) {
    return custom
      .replace(/\{\{produto\}\}/g, product.name)
      .replace(/\{\{conteudo\}\}/g, content);
  }

  switch (deliveryType) {
    case DeliveryType.LINK:
      return (
        `🎉 *Pagamento confirmado!*\n\n` +
        `📦 *Produto:* ${product.name}\n\n` +
        `🔗 Acesse através do link abaixo:\n${content}\n\n` +
        `⚠️ _Guarde este link em local seguro._`
      );
    case DeliveryType.ACCOUNT:
      return `🎉 *Pagamento confirmado!*\n\n📦 *Produto:* ${product.name}\n\n${content}`;
    default:
      return `🎉 *Pagamento confirmado!*\n\n📦 *Produto:* ${product.name}\n\n${content}`;
  }
}

async function sendMessageWithMedias(
  telegramId: string,
  message: string,
  medias: MediaEntry[]
): Promise<void> {
  const validMedias = medias.filter((m) => m.url.trim());

  if (validMedias.length === 0) {
    await telegramService.sendMessage(telegramId, message);
    return;
  }

  const messageTooBig = message.length > TELEGRAM_CAPTION_LIMIT;

  if (messageTooBig) {
    logger.warn(
      `Mensagem de entrega (${message.length} chars) ultrapassa limite de caption do Telegram (${TELEGRAM_CAPTION_LIMIT}). Enviando separado.`
    );
    await telegramService.sendMessage(telegramId, message);
    for (const media of validMedias) {
      await sendMedia(telegramId, media);
    }
    return;
  }

  const [first, ...rest] = validMedias;
  await sendMedia(telegramId, first, message);

  for (const media of rest) {
    await sendMedia(telegramId, media);
  }
}

async function sendMedia(
  telegramId: string,
  media: MediaEntry,
  captionOverride?: string
): Promise<void> {
  const caption = captionOverride ?? media.caption;
  try {
    if (media.mediaType === 'VIDEO') {
      await telegramService.sendVideo(telegramId, media.url, caption);
    } else if (media.mediaType === 'IMAGE') {
      await telegramService.sendPhoto(telegramId, media.url, caption);
    } else {
      const msg = caption ? `${caption}\n📎 ${media.url}` : `📎 ${media.url}`;
      await telegramService.sendMessage(telegramId, msg);
    }
  } catch (err) {
    logger.error(`Erro ao enviar mídia ${media.url}:`, err);
    throw err;
  }
}

function getProductMedias(product: Product): MediaEntry[] {
  const meta = product.metadata as Record<string, unknown> | null;
  if (!meta?.medias || !Array.isArray(meta.medias)) return [];
  return meta.medias as MediaEntry[];
}

async function getOrderMedias(orderId: string): Promise<MediaEntry[]> {
  const rows = await prisma.deliveryMedia.findMany({
    where: { orderId },
    orderBy: { sortOrder: 'asc' },
  });
  return rows.map((r) => ({
    url: r.url,
    mediaType: r.mediaType as 'IMAGE' | 'VIDEO' | 'FILE',
    caption: r.caption ?? undefined,
  }));
}

class DeliveryService {

  // OPT #10: timeout de 30s — se a entrega travar, rejeita e entra no fluxo de retry/fail
  async deliver(orderId: string, telegramUser: TelegramUser, product: Product): Promise<void> {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`[DeliveryTimeout] Entrega do pedido ${orderId} excedeu 30s`)), DELIVERY_TIMEOUT_MS)
    );

    return Promise.race([
      this._deliverInternal(orderId, telegramUser, product),
      timeoutPromise,
    ]);
  }

  private async _deliverInternal(orderId: string, telegramUser: TelegramUser, product: Product): Promise<void> {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new Error(`Pedido ${orderId} não encontrado`);
    if (order.status === 'DELIVERED') {
      logger.warn(`Pedido ${orderId} já entregue — ignorando tentativa duplicada`);
      return;
    }

    logger.info(`Iniciando entrega do pedido ${orderId}`);

    const itemContent = await stockService.getReservedItemContent(order.paymentId);

    let attempt = 0;
    let lastError: string | null = null;

    while (attempt < MAX_RETRIES) {
      attempt++;
      try {
        await this.executeDelivery(telegramUser.telegramId, product, orderId, itemContent);

        await prisma.$transaction([
          prisma.order.update({
            where: { id: orderId },
            data: { status: 'DELIVERED', deliveredAt: new Date() },
          }),
          prisma.deliveryLog.create({
            data: {
              orderId,
              attempt,
              status: 'SUCCESS',
              message: `Entrega realizada com sucesso via ${product.deliveryType}`,
            },
          }),
        ]);

        await stockService.markDelivered(order.paymentId, orderId);
        logger.info(`Pedido ${orderId} entregue com sucesso na tentativa ${attempt}`);
        return;

      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Erro desconhecido';
        logger.error(`Tentativa ${attempt}/${MAX_RETRIES} falhou para pedido ${orderId}:`, error);

        await prisma.deliveryLog.create({
          data: {
            orderId,
            attempt,
            status: attempt < MAX_RETRIES ? 'RETRYING' : 'FAILED',
            error: lastError,
          },
        });

        if (attempt < MAX_RETRIES) {
          const delay = Math.min(BASE_RETRY_MS * Math.pow(2, attempt - 1), MAX_RETRY_MS);
          await sleep(delay);
        }
      }
    }

    await prisma.order.update({ where: { id: orderId }, data: { status: 'FAILED' } });
    logger.error(`CRÍTICO: Entrega do pedido ${orderId} falhou após ${MAX_RETRIES} tentativas.`);

    try {
      await telegramService.sendDeliveryError(telegramUser.telegramId);
    } catch {
      logger.error(`Não foi possível notificar usuário ${telegramUser.telegramId} sobre falha`);
    }
  }

  private async executeDelivery(
    telegramId: string,
    product: Product,
    orderId: string,
    itemContent: string | null
  ): Promise<void> {
    const content = itemContent ?? product.deliveryContent ?? '';

    const productMedias = getProductMedias(product);
    const orderMedias = await getOrderMedias(orderId);
    const allMedias = [...productMedias, ...orderMedias];

    switch (product.deliveryType) {
      case DeliveryType.TEXT:
      case DeliveryType.LINK: {
        const message = buildConfirmationMessage(product, content, product.deliveryType);
        await sendMessageWithMedias(telegramId, message, allMedias);
        break;
      }

      case DeliveryType.ACCOUNT: {
        const message = await this.buildAccountMessage(product, content);
        await sendMessageWithMedias(telegramId, message, allMedias);
        break;
      }

      case DeliveryType.FILE_MEDIA: {
        const isVideo =
          /\.(mp4|mov|avi|mkv|webm)(\?|$)/i.test(content) ||
          content.includes('youtube.com') ||
          content.includes('youtu.be');

        const confirmMsg =
          `🎉 *Pagamento confirmado!*\n\n` +
          `📦 *Produto:* ${product.name}`;

        const mainMedia: MediaEntry = {
          url: content,
          mediaType: isVideo ? 'VIDEO' : 'IMAGE',
        };

        await sendMessageWithMedias(telegramId, confirmMsg, [mainMedia, ...allMedias]);
        break;
      }

      default:
        throw new Error(`Tipo de entrega desconhecido: ${product.deliveryType}`);
    }
  }

  private async buildAccountMessage(product: Product, content: string): Promise<string> {
    const meta = product.metadata as Record<string, unknown> | null;
    const custom = meta?.confirmationMessage as string | undefined;

    if (custom && custom.trim()) {
      return buildConfirmationMessage(product, content, DeliveryType.ACCOUNT);
    }

    let parsedContent: Record<string, unknown>;
    try {
      parsedContent = JSON.parse(content);
    } catch {
      return buildConfirmationMessage(product, content, DeliveryType.ACCOUNT);
    }

    return (
      `🎉 *${parsedContent.message || 'Acesso liberado!'}*\n\n` +
      `📦 *Produto:* ${product.name}\n\n` +
      (parsedContent.accessUrl ? `🌐 *URL de acesso:* ${parsedContent.accessUrl}\n\n` : '') +
      (parsedContent.instructions ? `📋 *Instruções:* ${parsedContent.instructions}\n\n` : '') +
      `⚠️ _Salve estas informações em local seguro._`
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const deliveryService = new DeliveryService();

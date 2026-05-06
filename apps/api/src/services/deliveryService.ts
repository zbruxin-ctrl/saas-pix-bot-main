// deliveryService.ts
// FEAT: mensagem de confirmação customizável via product.metadata.confirmationMessage
// FIX: primeira mídia enviada com caption acoplada
// OPT #10: timeout de 30s em deliver via Promise.race
// FEAT-QTY: _deliverInternal busca todos os StockItems do pagamento e entrega N conteúdos
//           numa única mensagem agrupada (ex: 10 licenças numa msg só)
// FIX-QTY4: _deliverInternal busca o próximo StockItem sem orderId (não repete o mesmo item)
// FIX-QTY5: deliverAllAsOne usa array mutável para fallback de conteúdo
// FIX-QTY6: confirmApproval não chama releaseReservation em caso de sucesso (evita liberar
//           itens já entregues); release só ocorre em finally de erro ou expiração
// PERF-QTY8: deliverAllAsOne paraleliza order.update + deliveryLog.create + markDelivered
//            via Promise.all — seguro pois markDelivered agora usa $transaction atômica
import { DeliveryType, TelegramUser, Product } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { telegramService } from './telegramService';
import { stockService } from './stockService';
import { logger } from '../lib/logger';

const MAX_RETRIES = 3;
const BASE_RETRY_MS = 3000;
const MAX_RETRY_MS = 15000;
const DELIVERY_TIMEOUT_MS = 30_000;
const TELEGRAM_CAPTION_LIMIT = 1024;

type MediaEntry = {
  url: string;
  mediaType: 'IMAGE' | 'VIDEO' | 'FILE';
  caption?: string;
};

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

/** Constrói mensagem agrupada para compras com qty > 1 */
function buildMultiItemMessage(product: Product, contents: string[], deliveryType: DeliveryType): string {
  const meta = product.metadata as Record<string, unknown> | null;
  const custom = meta?.confirmationMessage as string | undefined;

  const header =
    `✅ *Compra realizada com sucesso!*\n` +
    `📦 *${product.name}* (${contents.length}x)\n\n` +
    `*O conteúdo foi enviado na mensagem acima. Guarde em local seguro.*`;

  const items = contents
    .map((c, i) => `\n${contents.length > 1 ? `*${i + 1}.* ` : ''}\`${c}\``)
    .join('');

  const footer = `\n\n⚠️ _Os links são de uso único e não realizamos trocas. Utilize dentro do prazo._`;

  if (custom && custom.trim()) {
    const joined = contents.join('\n');
    return custom
      .replace(/\{\{produto\}\}/g, product.name)
      .replace(/\{\{conteudo\}\}/g, joined);
  }

  return header + items + footer;
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
      `Mensagem de entrega (${message.length} chars) ultrapassa limite de caption. Enviando separado.`
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

    // FIX-QTY4: busca o próximo StockItem vinculado ao paymentId que ainda NÃO tem orderId
    const nextItem = await prisma.stockItem.findFirst({
      where: {
        paymentId: order.paymentId!,
        orderId: null,
        status: { in: ['RESERVED', 'CONFIRMED'] },
      },
      orderBy: { createdAt: 'asc' },
      select: { content: true },
    });
    const itemContent = nextItem?.content ?? null;

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

        await stockService.markDelivered(order.paymentId!, orderId);
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

  /**
   * Entrega todos os conteúdos de um pagamento numa única mensagem agrupada.
   * PERF-QTY8: após enviar a mensagem, paraleliza o registro de cada order
   * (order.update + deliveryLog.create + markDelivered) via Promise.all.
   * Seguro pois markDelivered agora usa $transaction atômica no stockService.
   */
  async deliverAllAsOne(
    paymentId: string,
    telegramUser: TelegramUser,
    product: Product,
    orderIds: string[]
  ): Promise<void> {
    let contents = await stockService.getReservedItemsContent(paymentId);

    // FIX-QTY5: usa array mutável corretamente para fallback
    if (contents.length === 0) {
      const fallback = product.deliveryContent ?? '';
      contents = Array(orderIds.length).fill(fallback) as string[];
    }

    const message = buildMultiItemMessage(product, contents, product.deliveryType);
    const productMedias = getProductMedias(product);

    // Envia a mensagem PRIMEIRO (sequencial — única msg ao Telegram)
    await sendMessageWithMedias(telegramUser.telegramId, message, productMedias);

    // PERF-QTY8: paraleliza o registro de entrega de cada order
    // markDelivered é atômico ($transaction), então é seguro em paralelo
    await Promise.all(
      orderIds.map(async (orderId, i) => {
        await prisma.$transaction([
          prisma.order.update({
            where: { id: orderId },
            data: { status: 'DELIVERED', deliveredAt: new Date() },
          }),
          prisma.deliveryLog.create({
            data: {
              orderId,
              attempt: 1,
              status: 'SUCCESS',
              message: `Entrega agrupada (${orderIds.length} unidades)`,
            },
          }),
        ]);
        if (contents[i]) {
          await stockService.markDelivered(paymentId, orderId);
        }
      })
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const deliveryService = new DeliveryService();

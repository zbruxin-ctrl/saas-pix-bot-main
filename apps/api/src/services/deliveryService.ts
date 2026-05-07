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
// FIX-POOL2: deliverAllAsOne de volta a sequencial para não esgotar pool do Neon
//            (Promise.all com 6 orders abria 12 transações simultâneas → timeout)
// FIX-SEND-THEN-MARK: deliverAllAsOne envolve o envio Telegram em try/catch.
//   Se o envio falhar (ex: Markdown inválido → fallback texto puro → ainda 400),
//   a entrega no banco (DELIVERED + markDelivered) ocorre mesmo assim.
// FIX-BOT-SOURCE: deliver e deliverAllAsOne recebem botSource ('telegram' | 'whatsapp').
//   'whatsapp' → pula envio Telegram completamente (zero requests ao bot Telegram).
//   'telegram' / undefined → comportamento padrão (tenta enviar, fallback texto puro).
// FIX-QTY-TIMING: deliverAllAsOne faz polling de até 5 tentativas (500ms intervalo) para
//   aguardar todos os StockItems serem reservados antes de montar a mensagem.
//   Corrige race condition com setImmediate do _payWithBalance onde getReservedItemsContent
//   retornava menos itens que o qty comprado (ex: 2 de 5), causando mensagem incompleta.
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
        `\uD83C\uDF89 *Pagamento confirmado!*\n\n` +
        `\uD83D\uDCE6 *Produto:* ${product.name}\n\n` +
        `\uD83D\uDD17 Acesse através do link abaixo:\n${content}\n\n` +
        `\u26A0\uFE0F _Guarde este link em local seguro._`
      );
    case DeliveryType.ACCOUNT:
      return `\uD83C\uDF89 *Pagamento confirmado!*\n\n\uD83D\uDCE6 *Produto:* ${product.name}\n\n${content}`;
    default:
      return `\uD83C\uDF89 *Pagamento confirmado!*\n\n\uD83D\uDCE6 *Produto:* ${product.name}\n\n${content}`;
  }
}

/** Constrói mensagem agrupada para compras com qty > 1 */
function buildMultiItemMessage(product: Product, contents: string[], deliveryType: DeliveryType): string {
  const meta = product.metadata as Record<string, unknown> | null;
  const custom = meta?.confirmationMessage as string | undefined;

  const header =
    `\u2705 *Compra realizada com sucesso!*\n` +
    `\uD83D\uDCE6 *${product.name}* (${contents.length}x)\n\n` +
    `*O conteúdo foi enviado na mensagem acima. Guarde em local seguro.*`;

  const items = contents
    .map((c, i) => `\n${contents.length > 1 ? `*${i + 1}.* ` : ''}\`${c}\``)
    .join('');

  const footer = `\n\n\u26A0\uFE0F _Os links são de uso único e não realizamos trocas. Utilize dentro do prazo._`;

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
      const msg = caption ? `${caption}\n\uD83D\uDCCE ${media.url}` : `\uD83D\uDCCE ${media.url}`;
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

/**
 * FIX-QTY-TIMING: aguarda até qty StockItems estarem reservados para o paymentId.
 * Faz polling com até maxAttempts tentativas espaçadas por intervalMs.
 * Necessário porque _payWithBalance reserva os itens em background (setImmediate),
 * então deliverAllAsOne pode ser chamado antes de todos os itens estarem RESERVED.
 */
async function waitForReservedItems(
  paymentId: string,
  qty: number,
  maxAttempts = 5,
  intervalMs = 500
): Promise<string[]> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const contents = await stockService.getReservedItemsContent(paymentId);
    if (contents.length >= qty) {
      return contents;
    }
    if (attempt < maxAttempts) {
      logger.warn(
        `[waitForReservedItems] pagamento=${paymentId} — tentativa ${attempt}/${maxAttempts}: ` +
        `${contents.length}/${qty} itens reservados. Aguardando ${intervalMs}ms...`
      );
      await sleep(intervalMs);
    }
  }
  // Retorna o que tiver após esgotar tentativas (fallback será aplicado no caller)
  return stockService.getReservedItemsContent(paymentId);
}

class DeliveryService {

  /**
   * FIX-BOT-SOURCE: botSource opcional (padrão = 'telegram').
   * Para WhatsApp, pula o envio Telegram e marca diretamente como DELIVERED.
   */
  async deliver(
    orderId: string,
    telegramUser: TelegramUser,
    product: Product,
    botSource: 'telegram' | 'whatsapp' = 'telegram'
  ): Promise<void> {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`[DeliveryTimeout] Entrega do pedido ${orderId} excedeu 30s`)), DELIVERY_TIMEOUT_MS)
    );

    return Promise.race([
      this._deliverInternal(orderId, telegramUser, product, botSource),
      timeoutPromise,
    ]);
  }

  private async _deliverInternal(
    orderId: string,
    telegramUser: TelegramUser,
    product: Product,
    botSource: 'telegram' | 'whatsapp'
  ): Promise<void> {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new Error(`Pedido ${orderId} não encontrado`);
    if (order.status === 'DELIVERED') {
      logger.warn(`Pedido ${orderId} já entregue — ignorando tentativa duplicada`);
      return;
    }

    logger.info(`Iniciando entrega do pedido ${orderId} [botSource=${botSource}]`);

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

    // FIX-BOT-SOURCE: WhatsApp — pula envio Telegram, marca direto como DELIVERED
    if (botSource === 'whatsapp') {
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
            message: `Entrega via WhatsApp bot — conteúdo disponível em GET /delivered-items`,
          },
        }),
      ]);
      await stockService.markDelivered(order.paymentId!, orderId);
      logger.info(`Pedido ${orderId} marcado como DELIVERED (WhatsApp polling)`);
      return;
    }

    // Fluxo Telegram: tenta enviar com retries
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
          `\uD83C\uDF89 *Pagamento confirmado!*\n\n` +
          `\uD83D\uDCE6 *Produto:* ${product.name}`;

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
      `\uD83C\uDF89 *${parsedContent.message || 'Acesso liberado!'}*\n\n` +
      `\uD83D\uDCE6 *Produto:* ${product.name}\n\n` +
      (parsedContent.accessUrl ? `\uD83C\uDF10 *URL de acesso:* ${parsedContent.accessUrl}\n\n` : '') +
      (parsedContent.instructions ? `\uD83D\uDCCB *Instruções:* ${parsedContent.instructions}\n\n` : '') +
      `\u26A0\uFE0F _Salve estas informações em local seguro._`
    );
  }

  /**
   * Entrega todos os conteúdos de um pagamento numa única mensagem agrupada.
   * FIX-BOT-SOURCE: se botSource = 'whatsapp', pula o envio Telegram completamente.
   *   O banco é SEMPRE atualizado (DELIVERED + markDelivered), independente da origem.
   *   Bot WhatsApp busca os itens via GET /delivered-items (polling).
   * FIX-QTY-TIMING: aguarda todos os StockItems serem reservados antes de montar
   *   a mensagem, evitando race condition com setImmediate do _payWithBalance.
   */
  async deliverAllAsOne(
    paymentId: string,
    telegramUser: TelegramUser,
    product: Product,
    orderIds: string[],
    botSource: 'telegram' | 'whatsapp' = 'telegram'
  ): Promise<void> {
    // FIX-QTY-TIMING: aguarda até orderIds.length itens estarem reservados
    let contents = await waitForReservedItems(paymentId, orderIds.length);

    if (contents.length === 0) {
      const fallback = product.deliveryContent ?? '';
      contents = Array(orderIds.length).fill(fallback) as string[];
    } else if (contents.length < orderIds.length) {
      // Preenche os itens que faltam com fallback após esgotar tentativas
      const fallback = product.deliveryContent ?? '';
      logger.warn(
        `[deliverAllAsOne] pagamento=${paymentId} — apenas ${contents.length}/${orderIds.length} itens ` +
        `encontrados após polling. Completando com fallback.`
      );
      while (contents.length < orderIds.length) {
        contents.push(fallback);
      }
    }

    // FIX-BOT-SOURCE: WhatsApp — não envia nada ao Telegram, só marca no banco
    if (botSource !== 'whatsapp') {
      const message = buildMultiItemMessage(product, contents, product.deliveryType);
      const productMedias = getProductMedias(product);

      // FIX-SEND-THEN-MARK: falha de envio Telegram não aborta a entrega no banco
      try {
        await sendMessageWithMedias(telegramUser.telegramId, message, productMedias);
      } catch (err) {
        logger.warn(
          `[deliverAllAsOne] Envio Telegram falhou para pagamento=${paymentId} — ` +
          `continuando para marcar itens como DELIVERED no banco. Erro: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    } else {
      logger.info(
        `[deliverAllAsOne] botSource=whatsapp | pagamento=${paymentId} — ` +
        `pulando envio Telegram, itens disponíveis via GET /delivered-items`
      );
    }

    // FIX-POOL2: registra cada order SEQUENCIALMENTE para não esgotar pool do Neon.
    // Esta etapa SEMPRE ocorre, independente do botSource ou resultado do envio.
    for (let i = 0; i < orderIds.length; i++) {
      const orderId = orderIds[i];
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
            message: botSource === 'whatsapp'
              ? `Entrega via WhatsApp bot (${orderIds.length} unidades) — conteúdo via GET /delivered-items`
              : `Entrega agrupada (${orderIds.length} unidades)`,
          },
        }),
      ]);
      if (contents[i]) {
        await stockService.markDelivered(paymentId, orderId);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const deliveryService = new DeliveryService();

// ALTERAÇÕES:
// FIX #1: reserveStock no path legado usa $transaction atômica
// FIX #17: releaseExpiredReservations usa pixExpiresAt corretamente
// FIX-BUILD3: reason tornado opcional em releaseReservation
// FEAT-QTY: getReservedItemsContent retorna TODOS os StockItems de um pagamento
//           releaseReservation libera N itens de um pagamento
// FIX-QTY2: findUnique({paymentId}) → findFirst({where:{paymentId}}) pois paymentId não é mais unique
// FIX-QTY3: getReservedItemsContent e getReservedItemContent incluem DELIVERED para não perder
//           conteúdo quando releaseReservation corre antes da entrega terminar
// FIX-QTY4: confirmReservation confirma TODOS os StockItems do pagamento (não só o primeiro)
// FIX-QTY5: releaseReservation libera também itens CONFIRMED (não só RESERVED)
import { StockItemStatus, StockReservationStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

const RESERVATION_TTL_MS = 30 * 60 * 1000;

export class StockService {

  async getAvailableStock(productId: string): Promise<number | null> {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: {
        stock: true,
        _count: { select: { stockItems: true } },
      },
    });
    if (!product) return 0;
    if (product.stock === null && product._count.stockItems === 0) return null;

    if (product._count.stockItems > 0) {
      const available = await prisma.stockItem.count({
        where: { productId, status: StockItemStatus.AVAILABLE },
      });
      return available;
    }

    if (product.stock !== null) {
      const reserved = await prisma.stockReservation.count({
        where: {
          productId,
          status: StockReservationStatus.ACTIVE,
          expiresAt: { gt: new Date() },
        },
      });
      return Math.max(0, product.stock - reserved);
    }

    return null;
  }

  async reserveStock(
    productId: string,
    telegramUserId: string,
    paymentId: string
  ): Promise<void> {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { stock: true, _count: { select: { stockItems: true } } },
    });
    if (!product) throw new Error('Produto não encontrado.');

    const hasItems = product._count.stockItems > 0;

    if (hasItems) {
      await prisma.$transaction(async (tx) => {
        const item = await tx.stockItem.findFirst({
          where: { productId, status: StockItemStatus.AVAILABLE },
          orderBy: { createdAt: 'asc' },
        });

        if (!item) throw new Error('Produto esgotado. Nenhuma unidade disponível.');

        await tx.stockItem.update({
          where: { id: item.id },
          data: { status: StockItemStatus.RESERVED, paymentId, reservedAt: new Date() },
        });

        logger.info(
          `[StockService] StockItem FIFO reservado | item=${item.id} | produto=${productId} | pagamento=${paymentId} | usuario=${telegramUserId}`
        );
      });
      return;
    }

    if (product.stock !== null) {
      await prisma.$transaction(async (tx) => {
        const activeReservations = await tx.stockReservation.count({
          where: {
            productId,
            status: StockReservationStatus.ACTIVE,
            expiresAt: { gt: new Date() },
          },
        });

        const prod = await tx.product.findUnique({
          where: { id: productId },
          select: { stock: true },
        });

        const currentStock = prod?.stock ?? 0;
        if (currentStock - activeReservations <= 0) {
          throw new Error('Produto esgotado. Estoque indisponível no momento.');
        }

        const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);
        await tx.stockReservation.create({
          data: {
            productId,
            telegramUserId,
            paymentId,
            quantity: 1,
            status: StockReservationStatus.ACTIVE,
            expiresAt,
          },
        });

        logger.info(
          `[StockService] Reserva legada criada | produto=${productId} | pagamento=${paymentId} | usuario=${telegramUserId}`
        );
      });
      return;
    }
  }

  // FIX-QTY4: confirma TODOS os StockItems do pagamento (não só o primeiro)
  async confirmReservation(paymentId: string): Promise<void> {
    const items = await prisma.stockItem.findMany({
      where: { paymentId, status: StockItemStatus.RESERVED },
    });

    if (items.length > 0) {
      await prisma.stockItem.updateMany({
        where: { paymentId, status: StockItemStatus.RESERVED },
        data: { status: StockItemStatus.CONFIRMED, confirmedAt: new Date() },
      });
      logger.info(
        `[StockService] ${items.length} StockItem(s) confirmados | pagamento=${paymentId}`
      );
      return;
    }

    // Path legado: StockReservation
    await prisma.$transaction(async (tx) => {
      const reservation = await tx.stockReservation.findUnique({
        where: { paymentId },
        include: { product: true },
      });
      if (!reservation) return;
      if (reservation.status !== StockReservationStatus.ACTIVE) return;
      await tx.stockReservation.update({
        where: { id: reservation.id },
        data: { status: StockReservationStatus.CONFIRMED, confirmedAt: new Date() },
      });
      if (reservation.product.stock !== null) {
        await tx.product.update({
          where: { id: reservation.productId },
          data: { stock: { decrement: reservation.quantity } },
        });
      }
    });
  }

  // FIX-QTY5: libera itens RESERVED e CONFIRMED (não só RESERVED)
  async releaseReservation(paymentId: string, reason?: string): Promise<void> {
    const resolvedReason = reason ?? 'não especificado';

    const items = await prisma.stockItem.findMany({
      where: {
        paymentId,
        status: { in: [StockItemStatus.RESERVED, StockItemStatus.CONFIRMED] },
      },
    });

    if (items.length > 0) {
      await prisma.stockItem.updateMany({
        where: {
          paymentId,
          status: { in: [StockItemStatus.RESERVED, StockItemStatus.CONFIRMED] },
        },
        data: {
          status: StockItemStatus.AVAILABLE,
          paymentId: null,
          reservedAt: null,
          releasedAt: new Date(),
        },
      });
      logger.info(
        `[StockService] ${items.length} StockItem(s) liberados | pagamento=${paymentId} | motivo=${resolvedReason}`
      );
      return;
    }

    const reservation = await prisma.stockReservation.findUnique({ where: { paymentId } });
    if (!reservation || reservation.status !== StockReservationStatus.ACTIVE) return;
    await prisma.stockReservation.update({
      where: { id: reservation.id },
      data: { status: StockReservationStatus.RELEASED, releasedAt: new Date() },
    });
    logger.info(
      `[StockService] Reserva legada liberada | id=${reservation.id} | produto=${reservation.productId} | pagamento=${paymentId} | motivo=${resolvedReason}`
    );
  }

  async markDelivered(paymentId: string, orderId: string): Promise<void> {
    const item = await prisma.stockItem.findFirst({
      where: {
        paymentId,
        orderId: null,
        status: { in: [StockItemStatus.RESERVED, StockItemStatus.CONFIRMED] },
      },
    });
    if (!item) return;
    await prisma.stockItem.update({
      where: { id: item.id },
      data: { status: StockItemStatus.DELIVERED, orderId, deliveredAt: new Date() },
    });
    logger.info(
      `[StockService] StockItem entregue | item=${item.id} | pagamento=${paymentId} | pedido=${orderId}`
    );
  }

  async getReservedItemContent(paymentId: string): Promise<string | null> {
    // Inclui DELIVERED para não perder conteúdo quando release antecipa a leitura
    const item = await prisma.stockItem.findFirst({
      where: {
        paymentId,
        status: { in: [StockItemStatus.RESERVED, StockItemStatus.CONFIRMED, StockItemStatus.DELIVERED] },
      },
      orderBy: { createdAt: 'asc' },
    });
    return item?.content ?? null;
  }

  async getReservedItemsContent(paymentId: string): Promise<string[]> {
    // Inclui DELIVERED para não perder conteúdo quando release antecipa a leitura
    const items = await prisma.stockItem.findMany({
      where: {
        paymentId,
        status: { in: [StockItemStatus.RESERVED, StockItemStatus.CONFIRMED, StockItemStatus.DELIVERED] },
      },
      orderBy: { createdAt: 'asc' },
      select: { content: true },
    });
    return items.map((i) => i.content ?? '');
  }

  async releaseExpiredReservations(): Promise<number> {
    const cutoff = new Date(Date.now() - RESERVATION_TTL_MS);

    const itemsResult = await prisma.stockItem.updateMany({
      where: { status: StockItemStatus.RESERVED, reservedAt: { lt: cutoff } },
      data: {
        status: StockItemStatus.AVAILABLE,
        paymentId: null,
        reservedAt: null,
        releasedAt: new Date(),
      },
    });

    if (itemsResult.count > 0) {
      logger.info(`[StockService] ${itemsResult.count} StockItems expirados liberados (FIFO)`);
    }

    const legacyResult = await prisma.stockReservation.updateMany({
      where: { status: StockReservationStatus.ACTIVE, expiresAt: { lt: new Date() } },
      data: { status: StockReservationStatus.RELEASED, releasedAt: new Date() },
    });
    if (legacyResult.count > 0) {
      logger.info(`[StockService] ${legacyResult.count} reservas legadas expiradas liberadas`);
    }

    return itemsResult.count + legacyResult.count;
  }
}

export const stockService = new StockService();

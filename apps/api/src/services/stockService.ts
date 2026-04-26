// ALTERAÇÕES: logs com IDs de correlação completos em todos os métodos
// (productId, paymentId, telegramUserId, itemId, orderId)
import { StockItemStatus, StockReservationStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

const RESERVATION_TTL_MS = 30 * 60 * 1000;

export class StockService {

  async getAvailableStock(productId: string): Promise<number | null> {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { stock: true },
    });
    if (!product) return 0;
    if (product.stock === null) return null;

    const hasItems = await prisma.stockItem.count({ where: { productId } });
    if (hasItems > 0) {
      const available = await prisma.stockItem.count({
        where: { productId, status: StockItemStatus.AVAILABLE },
      });
      return available;
    }

    const reserved = await prisma.stockReservation.count({
      where: {
        productId,
        status: StockReservationStatus.ACTIVE,
        expiresAt: { gt: new Date() },
      },
    });
    return Math.max(0, product.stock - reserved);
  }

  async reserveStock(
    productId: string,
    telegramUserId: string,
    paymentId: string
  ): Promise<void> {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { stock: true },
    });
    if (!product) throw new Error('Produto não encontrado.');

    const hasItems = await prisma.stockItem.count({ where: { productId } });

    if (hasItems > 0) {
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
      const available = await this.getAvailableStock(productId);
      if (available !== null && available <= 0) {
        throw new Error('Produto esgotado. Estoque indisponível no momento.');
      }
    }

    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);
    await prisma.stockReservation.create({
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
  }

  async confirmReservation(paymentId: string): Promise<void> {
    const item = await prisma.stockItem.findUnique({ where: { paymentId } });
    if (item) {
      if (item.status !== StockItemStatus.RESERVED) {
        logger.warn(
          `[StockService] StockItem já está com status ${item.status} | item=${item.id} | pagamento=${paymentId}`
        );
        return;
      }
      await prisma.stockItem.update({
        where: { id: item.id },
        data: { status: StockItemStatus.CONFIRMED, confirmedAt: new Date() },
      });
      logger.info(
        `[StockService] StockItem confirmado | item=${item.id} | produto=${item.productId} | pagamento=${paymentId}`
      );
      return;
    }

    await prisma.$transaction(async (tx) => {
      const reservation = await tx.stockReservation.findUnique({
        where: { paymentId },
        include: { product: true },
      });
      if (!reservation) {
        logger.warn(
          `[StockService] Nenhuma reserva encontrada para pagamento=${paymentId} — produto pode ser ilimitado`
        );
        return;
      }
      if (reservation.status !== StockReservationStatus.ACTIVE) {
        logger.warn(
          `[StockService] Reserva já está com status ${reservation.status} | id=${reservation.id} | pagamento=${paymentId}`
        );
        return;
      }
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
      logger.info(
        `[StockService] Reserva legada confirmada | id=${reservation.id} | produto=${reservation.productId} | pagamento=${paymentId}`
      );
    });
  }

  async releaseReservation(paymentId: string, reason: string): Promise<void> {
    const item = await prisma.stockItem.findUnique({ where: { paymentId } });
    if (item) {
      if (item.status !== StockItemStatus.RESERVED) return;
      await prisma.stockItem.update({
        where: { id: item.id },
        data: {
          status: StockItemStatus.AVAILABLE,
          paymentId: null,
          reservedAt: null,
          releasedAt: new Date(),
        },
      });
      logger.info(
        `[StockService] StockItem liberado | item=${item.id} | produto=${item.productId} | pagamento=${paymentId} | motivo=${reason}`
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
      `[StockService] Reserva legada liberada | id=${reservation.id} | produto=${reservation.productId} | pagamento=${paymentId} | motivo=${reason}`
    );
  }

  async markDelivered(paymentId: string, orderId: string): Promise<void> {
    const item = await prisma.stockItem.findUnique({ where: { paymentId } });
    if (!item) return;
    await prisma.stockItem.update({
      where: { id: item.id },
      data: { status: StockItemStatus.DELIVERED, orderId, deliveredAt: new Date() },
    });
    logger.info(
      `[StockService] StockItem entregue | item=${item.id} | produto=${item.productId} | pagamento=${paymentId} | pedido=${orderId}`
    );
  }

  async getReservedItemContent(paymentId: string): Promise<string | null> {
    const item = await prisma.stockItem.findUnique({ where: { paymentId } });
    return item?.content ?? null;
  }

  async releaseExpiredReservations(): Promise<number> {
    const cutoff = new Date(Date.now() - RESERVATION_TTL_MS);
    const expiredItems = await prisma.stockItem.findMany({
      where: { status: StockItemStatus.RESERVED, reservedAt: { lt: cutoff } },
      select: { id: true },
    });

    if (expiredItems.length > 0) {
      await prisma.stockItem.updateMany({
        where: { id: { in: expiredItems.map((i) => i.id) } },
        data: {
          status: StockItemStatus.AVAILABLE,
          paymentId: null,
          reservedAt: null,
          releasedAt: new Date(),
        },
      });
      logger.info(
        `[StockService] ${expiredItems.length} StockItems expirados liberados (FIFO)`
      );
    }

    const legacyResult = await prisma.stockReservation.updateMany({
      where: { status: StockReservationStatus.ACTIVE, expiresAt: { lt: new Date() } },
      data: { status: StockReservationStatus.RELEASED, releasedAt: new Date() },
    });
    if (legacyResult.count > 0) {
      logger.info(
        `[StockService] ${legacyResult.count} reservas legadas expiradas liberadas`
      );
    }

    return expiredItems.length + legacyResult.count;
  }
}

export const stockService = new StockService();

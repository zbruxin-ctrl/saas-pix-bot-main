// ALTERAÇÕES:
// FIX #1: reserveStock no path legado (stock numérico) agora usa $transaction atômica
//         para evitar race condition entre getAvailableStock e create
// FIX #17: releaseExpiredReservations usa pixExpiresAt corretamente
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

    // PATH FIFO (StockItem) — já era atômico
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

    // PATH LEGADO (stock numérico)
    // FIX #1: envolve o check de disponibilidade e o create numa única $transaction
    // para eliminar a race condition entre o count e o create.
    if (product.stock !== null) {
      await prisma.$transaction(async (tx) => {
        // Conta reservas ativas dentro da transaction
        const activeReservations = await tx.stockReservation.count({
          where: {
            productId,
            status: StockReservationStatus.ACTIVE,
            expiresAt: { gt: new Date() },
          },
        });

        // Relê o stock dentro da transaction para garantir consistência
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

    // Produto ilimitado (stock === null e sem StockItems) — sem reserva necessária
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

  // FIX #17: usa pixExpiresAt para payments (campo correto) + updateMany direto
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
      logger.info(
        `[StockService] ${itemsResult.count} StockItems expirados liberados (FIFO)`
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

    return itemsResult.count + legacyResult.count;
  }
}

export const stockService = new StockService();

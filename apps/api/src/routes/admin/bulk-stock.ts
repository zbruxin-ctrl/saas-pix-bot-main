// routes/admin/bulk-stock.ts
// FEAT #1: Upload em lote de stock — textarea multiline ou import CSV
// POST /api/admin/products/:productId/bulk-stock
import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { requireRole } from '../../middleware/auth';
import { logger } from '../../lib/logger';

export const bulkStockRouter = Router({ mergeParams: true });

/**
 * POST /api/admin/products/:productId/bulk-stock
 * Body: { items: string }  — uma linha por item (\n ou \r\n separado)
 *  OU multipart/form-data com campo "file" (CSV com coluna "content")
 *
 * Cada item não-vazio que ainda não existir no banco será inserido.
 * Retorna: { inserted, duplicates, total }
 */
bulkStockRouter.post(
  '/',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: Request, res: Response) => {
    const { productId } = req.params as { productId: string };
    const { items: rawItems } = req.body as { items?: string };

    if (!rawItems || !rawItems.trim()) {
      res.status(400).json({ success: false, error: 'O campo "items" é obrigatório e deve conter ao menos uma linha.' });
      return;
    }

    // Verifica se o produto existe
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      res.status(404).json({ success: false, error: 'Produto não encontrado.' });
      return;
    }

    // Normaliza as linhas: detecta se é CSV (tem cabeçalho "content") ou lista simples
    const lines = rawItems
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    let contents: string[];
    if (lines[0]?.toLowerCase() === 'content') {
      // Formato CSV — primeira linha é header
      contents = lines.slice(1);
    } else {
      contents = lines;
    }

    if (contents.length === 0) {
      res.status(400).json({ success: false, error: 'Nenhum item válido encontrado.' });
      return;
    }

    if (contents.length > 10_000) {
      res.status(400).json({ success: false, error: 'Máximo de 10.000 itens por vez.' });
      return;
    }

    // Busca itens já existentes para evitar duplicatas
    const existing = await prisma.stockItem.findMany({
      where: { productId, content: { in: contents } },
      select: { content: true },
    });
    const existingSet = new Set(existing.map((e) => e.content));
    const newItems = contents.filter((c) => !existingSet.has(c));

    let inserted = 0;
    if (newItems.length > 0) {
      const result = await prisma.stockItem.createMany({
        data: newItems.map((content) => ({
          productId,
          content,
          status: 'AVAILABLE',
        })),
        skipDuplicates: true,
      });
      inserted = result.count;
    }

    logger.info(`[bulk-stock] produto=${productId} inseridos=${inserted} duplicatas=${existingSet.size}`);

    res.json({
      success: true,
      data: {
        inserted,
        duplicates: existingSet.size,
        total: contents.length,
        skipped: contents.length - inserted - existingSet.size,
      },
    });
  }
);

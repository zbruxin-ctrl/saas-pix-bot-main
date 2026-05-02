// pricing.ts — rotas de pricing/volume tiers
import { Router, Request, Response } from 'express';
import { requireBotSecret } from '../middleware/auth';
import { getEffectiveTier } from '../services/pricingService';
import { prisma } from '../lib/prisma';

export const pricingRouter = Router();

// GET /api/pricing?productId=xxx&qty=N
// Retorna o preço final aplicando volume tier
pricingRouter.get(
  '/',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const { productId, qty } = req.query as { productId?: string; qty?: string };

    if (!productId) {
      res.status(400).json({ success: false, error: 'productId é obrigatório' });
      return;
    }

    const quantity = qty ? parseInt(qty, 10) : 1;
    if (isNaN(quantity) || quantity < 1) {
      res.status(400).json({ success: false, error: 'qty deve ser >= 1' });
      return;
    }

    const product = await prisma.product.findUnique({
      where: { id: productId, isActive: true },
      select: { id: true, name: true, price: true },
    });

    if (!product) {
      res.status(404).json({ success: false, error: 'Produto não encontrado' });
      return;
    }

    const tier = await getEffectiveTier(productId, quantity);

    res.json({
      success: true,
      data: {
        productId: product.id,
        productName: product.name,
        unitPrice: Number(product.price),
        qty: quantity,
        originalAmount: tier?.originalAmount ?? Number(product.price) * quantity,
        finalAmount: tier?.finalAmount ?? Number(product.price) * quantity,
        discountPercent: tier?.discountPercent ?? 0,
        tierId: tier?.tierId ?? null,
      },
    });
  }
);

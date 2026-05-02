// routes/admin/coupons.ts
// CRUD de cupons + CRUD de volume tiers
// GET  /admin/coupons              — lista cupons
// POST /admin/coupons              — cria cupom
// PUT  /admin/coupons/:id          — atualiza cupom
// DELETE /admin/coupons/:id        — remove cupom
// GET  /admin/coupons/volume-tiers — lista tiers de volume
// POST /admin/coupons/volume-tiers — cria tier de volume
// DELETE /admin/coupons/volume-tiers/:id — remove tier
import { Router, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { requireRole, AuthenticatedRequest } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';

export const adminCouponsRouter = Router();

adminCouponsRouter.use(requireRole('ADMIN', 'SUPERADMIN'));

// ─── Coupons ──────────────────────────────────────────────────────────────────

adminCouponsRouter.get('/', async (_req: AuthenticatedRequest, res: Response) => {
  const coupons = await prisma.coupon.findMany({
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { uses: true } } },
  });
  res.json({ success: true, data: coupons });
});

adminCouponsRouter.post('/', async (req: AuthenticatedRequest, res: Response) => {
  const {
    code,
    description,
    discountType = 'PERCENT',
    discountValue,
    minOrderValue,
    maxUses,
    isActive = true,
    validUntil,
    productIds,
  } = req.body;

  if (!code || discountValue === undefined) {
    throw new AppError('code e discountValue são obrigatórios.', 400);
  }
  if (!['PERCENT', 'FIXED'].includes(discountType)) {
    throw new AppError('discountType deve ser PERCENT ou FIXED.', 400);
  }

  const coupon = await prisma.coupon.create({
    data: {
      code: String(code).toUpperCase().trim(),
      description: description ?? null,
      discountType,
      discountValue: Number(discountValue),
      minOrderValue: minOrderValue != null ? Number(minOrderValue) : null,
      maxUses: maxUses != null ? Number(maxUses) : null,
      isActive: Boolean(isActive),
      validUntil: validUntil ? new Date(validUntil) : null,
      productIds: productIds ? JSON.stringify(productIds) : null,
    },
  });

  res.status(201).json({ success: true, data: coupon });
});

adminCouponsRouter.put('/:id', async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const {
    code,
    description,
    discountType,
    discountValue,
    minOrderValue,
    maxUses,
    isActive,
    validUntil,
    productIds,
  } = req.body;

  const existing = await prisma.coupon.findUnique({ where: { id } });
  if (!existing) throw new AppError('Cupom não encontrado.', 404);

  const updated = await prisma.coupon.update({
    where: { id },
    data: {
      ...(code !== undefined && { code: String(code).toUpperCase().trim() }),
      ...(description !== undefined && { description }),
      ...(discountType !== undefined && { discountType }),
      ...(discountValue !== undefined && { discountValue: Number(discountValue) }),
      ...(minOrderValue !== undefined && { minOrderValue: minOrderValue !== null ? Number(minOrderValue) : null }),
      ...(maxUses !== undefined && { maxUses: maxUses !== null ? Number(maxUses) : null }),
      ...(isActive !== undefined && { isActive: Boolean(isActive) }),
      ...(validUntil !== undefined && { validUntil: validUntil ? new Date(validUntil) : null }),
      ...(productIds !== undefined && { productIds: productIds ? JSON.stringify(productIds) : null }),
    },
  });

  res.json({ success: true, data: updated });
});

adminCouponsRouter.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  if (id === 'volume-tiers') {
    // evita conflito com sub-rota — o express já deve rotear corretamente mas guard extra
    throw new AppError('Rota inválida.', 400);
  }
  const existing = await prisma.coupon.findUnique({ where: { id } });
  if (!existing) throw new AppError('Cupom não encontrado.', 404);
  await prisma.coupon.delete({ where: { id } });
  res.json({ success: true });
});

// ─── Volume Tiers ─────────────────────────────────────────────────────────────

adminCouponsRouter.get('/volume-tiers', async (_req: AuthenticatedRequest, res: Response) => {
  const tiers = await prisma.volumeTier.findMany({
    orderBy: [{ productId: 'asc' }, { minQty: 'asc' }],
    include: { product: { select: { id: true, name: true } } },
  });
  res.json({ success: true, data: tiers });
});

adminCouponsRouter.post('/volume-tiers', async (req: AuthenticatedRequest, res: Response) => {
  const { productId, minQty, discountPercent, label } = req.body;

  if (minQty === undefined || discountPercent === undefined) {
    throw new AppError('minQty e discountPercent são obrigatórios.', 400);
  }
  if (Number(minQty) < 2) throw new AppError('minQty deve ser >= 2.', 400);
  if (Number(discountPercent) <= 0 || Number(discountPercent) > 100) {
    throw new AppError('discountPercent deve ser entre 0.01 e 100.', 400);
  }

  const tier = await prisma.volumeTier.create({
    data: {
      productId: productId ?? null,
      minQty: Number(minQty),
      discountPercent: Number(discountPercent),
      label: label ?? null,
    },
  });
  res.status(201).json({ success: true, data: tier });
});

adminCouponsRouter.delete('/volume-tiers/:id', async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;
  const existing = await prisma.volumeTier.findUnique({ where: { id } });
  if (!existing) throw new AppError('Tier não encontrado.', 404);
  await prisma.volumeTier.delete({ where: { id } });
  res.json({ success: true });
});

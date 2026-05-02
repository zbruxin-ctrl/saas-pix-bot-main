// coupons.ts — rotas de cupons
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireBotSecret } from '../middleware/auth';
import { validateCoupon, applyCoupon, revertCoupon } from '../services/couponService';

export const couponsRouter = Router();

const validateSchema = z.object({
  code: z.string().min(1),
  telegramId: z.string().min(1),
  orderAmount: z.number().positive(),
  productId: z.string().optional(),
});

const applySchema = z.object({
  couponId: z.string().min(1),
  telegramUserId: z.string().min(1),
  paymentId: z.string().min(1),
});

const revertSchema = z.object({
  paymentId: z.string().min(1),
});

// POST /api/coupons/validate
// Valida o cupom sem consumi-lo. Retorna preço final.
couponsRouter.post(
  '/validate',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const parsed = validateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.issues[0].message });
      return;
    }

    const { code, telegramId, orderAmount, productId } = parsed.data;
    const result = await validateCoupon(code, telegramId, orderAmount, productId);

    if (!result.valid) {
      res.status(400).json({ success: false, error: result.error });
      return;
    }

    res.json({ success: true, data: result });
  }
);

// POST /api/coupons/apply
// Consome o cupom (cria CouponUse + incrementa usedCount).
couponsRouter.post(
  '/apply',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.issues[0].message });
      return;
    }

    const { couponId, telegramUserId, paymentId } = parsed.data;
    await applyCoupon(couponId, telegramUserId, paymentId);
    res.json({ success: true });
  }
);

// POST /api/coupons/revert
// Reverte o uso do cupom (deleta CouponUse + decrementa usedCount).
couponsRouter.post(
  '/revert',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const parsed = revertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.issues[0].message });
      return;
    }

    await revertCoupon(parsed.data.paymentId);
    res.json({ success: true });
  }
);

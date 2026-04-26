// Rotas de autenticação do painel admin
// FIX S2/M8: maxAge do cookie sincronizado com JWT_EXPIRES_IN
//   Parse de '7d', '1h', '30m' etc para ms real — sem hardcode de 7 dias
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import { loginRateLimit } from '../middleware/rateLimit';
import { env } from '../config/env';
import { logger } from '../lib/logger';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(6, 'Senha muito curta'),
});

// Converte string de expiração do JWT (ex: '7d', '12h', '30m', '3600') para ms
function parseDurationToMs(duration: string): number {
  const n = parseInt(duration, 10);
  if (!Number.isNaN(n) && String(n) === duration) return n * 1000; // segundos numéricos puros
  const unit = duration.slice(-1);
  const value = parseInt(duration.slice(0, -1), 10);
  if (Number.isNaN(value)) return 7 * 24 * 60 * 60 * 1000; // fallback 7 dias
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    case 'w': return value * 7 * 24 * 60 * 60 * 1000;
    default:  return 7 * 24 * 60 * 60 * 1000;
  }
}

const cookieMaxAge = parseDurationToMs(env.JWT_EXPIRES_IN);

// POST /api/auth/login
authRouter.post('/login', loginRateLimit, async (req: Request, res: Response) => {
  const { email, password } = loginSchema.parse(req.body);

  const admin = await prisma.adminUser.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (!admin || !admin.isActive) {
    await bcrypt.compare(password, '$2b$12$invalid.hash.to.prevent.timing.attacks.xxxxx');
    res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    return;
  }

  const isValidPassword = await bcrypt.compare(password, admin.passwordHash);
  if (!isValidPassword) {
    logger.warn(`Tentativa de login falhou para: ${email}`);
    res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    return;
  }

  const token = jwt.sign(
    { adminId: admin.id, email: admin.email, role: admin.role },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
  );

  await prisma.adminUser.update({
    where: { id: admin.id },
    data: { lastLoginAt: new Date() },
  });

  logger.info(`Admin logado: ${email}`);

  // FIX S2: maxAge derivado de JWT_EXPIRES_IN — cookie e token expiram juntos
  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none' as const,
    maxAge: cookieMaxAge,
    signed: true,
  });

  res.cookie('auth_presence', '1', {
    httpOnly: false,
    secure: true,
    sameSite: 'none' as const,
    maxAge: cookieMaxAge,
  });

  res.json({
    success: true,
    data: {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
    },
  });
});

// POST /api/auth/logout
authRouter.post('/logout', requireAuth, (_req: Request, res: Response) => {
  res.clearCookie('auth_token', { secure: true, sameSite: 'none' as const });
  res.clearCookie('auth_presence', { secure: true, sameSite: 'none' as const });
  res.json({ success: true, message: 'Logout realizado com sucesso' });
});

// GET /api/auth/me
authRouter.get('/me', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const admin = await prisma.adminUser.findUnique({
    where: { id: req.admin!.id },
    select: { id: true, email: true, name: true, role: true, lastLoginAt: true },
  });
  res.json({ success: true, data: admin });
});

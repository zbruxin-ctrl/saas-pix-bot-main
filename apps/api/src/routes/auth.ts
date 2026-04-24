// Rotas de autenticação do painel admin
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

// POST /api/auth/login
authRouter.post('/login', loginRateLimit, async (req: Request, res: Response) => {
  const { email, password } = loginSchema.parse(req.body);

  // Busca admin pelo email
  const admin = await prisma.adminUser.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (!admin || !admin.isActive) {
    // Tempo constante para evitar timing attack
    await bcrypt.compare(password, '$2b$12$invalid.hash.to.prevent.timing.attacks.xxxxx');
    res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    return;
  }

  // Verifica senha
  const isValidPassword = await bcrypt.compare(password, admin.passwordHash);
  if (!isValidPassword) {
    logger.warn(`Tentativa de login falhou para: ${email}`);
    res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    return;
  }

  // Gera token JWT
  const token = jwt.sign(
    { adminId: admin.id, email: admin.email, role: admin.role },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
  );

  // Atualiza último login
  await prisma.adminUser.update({
    where: { id: admin.id },
    data: { lastLoginAt: new Date() },
  });

  logger.info(`Admin logado: ${email}`);

  // Cookie httpOnly com JWT real (protegido contra XSS)
  // Em desenvolvimento usa 'lax' para funcionar entre portas diferentes (3000 -> 3001)
  res.cookie('auth_token', token, {
  httpOnly: true,
  secure: true,
  sameSite: 'none' as const,
  ...
    maxAge: 7 * 24 * 60 * 60 * 1000,
    signed: true,
  });

  // Cookie não-httpOnly para o middleware Next.js detectar sessão ativa
  res.cookie('auth_presence', '1', {
    httpOnly: false,
    secure: true,
    sameSite: 'none' as const,
    maxAge: 7 * 24 * 60 * 60 * 1000,
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
  res.clearCookie('auth_token', { secure: true, sameSite: 'none' as const, });
  res.clearCookie('auth_presence', { secure: true, sameSite: 'none' as const, });
  res.json({ success: true, message: 'Logout realizado com sucesso' });
});

// GET /api/auth/me - Retorna dados do admin logado
authRouter.get('/me', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const admin = await prisma.adminUser.findUnique({
    where: { id: req.admin!.id },
    select: { id: true, email: true, name: true, role: true, lastLoginAt: true },
  });

  res.json({ success: true, data: admin });
});

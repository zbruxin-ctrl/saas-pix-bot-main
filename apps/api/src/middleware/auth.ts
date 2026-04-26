// middleware/auth.ts — autenticação JWT com cache em memória (TTL 30s)
// FIX #11: cache de 30s por adminId evita query ao banco em todo request
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';

export interface AuthenticatedRequest extends Request {
  admin?: {
    id: string;
    email: string;
    role: string;
  };
}

// Cache em memória: adminId → { data, expiresAt }
// Sem external deps (sem Redis); TTL curto garante que desativações sejam respeitadas em ≤30s
interface CachedAdmin {
  id: string;
  email: string;
  role: string;
  isActive: boolean;
  expiresAt: number;
}
const adminCache = new Map<string, CachedAdmin>();
const CACHE_TTL_MS = 30_000; // 30 segundos

async function getAdminCached(adminId: string): Promise<CachedAdmin | null> {
  const cached = adminCache.get(adminId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const admin = await prisma.adminUser.findUnique({
    where: { id: adminId },
    select: { id: true, email: true, role: true, isActive: true },
  });

  if (!admin) {
    adminCache.delete(adminId);
    return null;
  }

  const entry: CachedAdmin = { ...admin, expiresAt: Date.now() + CACHE_TTL_MS };
  adminCache.set(adminId, entry);
  return entry;
}

// Permite invalidar o cache de um admin específico (ex: após desativar)
export function invalidateAdminCache(adminId: string): void {
  adminCache.delete(adminId);
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token =
      req.signedCookies?.auth_token ||
      req.cookies?.auth_token ||
      extractBearerToken(req);

    if (!token) {
      res.status(401).json({ success: false, error: 'Não autorizado' });
      return;
    }

    const payload = jwt.verify(token, env.JWT_SECRET) as {
      adminId: string;
      email: string;
      role: string;
    };

    const admin = await getAdminCached(payload.adminId);

    if (!admin || !admin.isActive) {
      res.status(401).json({ success: false, error: 'Sessão inválida' });
      return;
    }

    req.admin = { id: admin.id, email: admin.email, role: admin.role };
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ success: false, error: 'Sessão expirada' });
      return;
    }
    res.status(401).json({ success: false, error: 'Token inválido' });
  }
}

export function requireRole(...roles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.admin || !roles.includes(req.admin.role)) {
      res.status(403).json({ success: false, error: 'Acesso negado' });
      return;
    }
    next();
  };
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  return null;
}

export function requireBotSecret(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const secret = req.headers['x-bot-secret'];
  if (!secret || secret !== env.TELEGRAM_BOT_SECRET) {
    res.status(401).json({ success: false, error: 'Não autorizado' });
    return;
  }
  next();
}

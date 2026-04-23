// Middleware de autenticação JWT para rotas do painel admin
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

// Verifica token JWT do cookie ou header Authorization
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Tenta pegar token do cookie primeiro, depois do header
    const token =
      req.signedCookies?.auth_token ||
      req.cookies?.auth_token ||
      extractBearerToken(req);

    if (!token) {
      res.status(401).json({ success: false, error: 'Não autorizado' });
      return;
    }

    // Verifica e decodifica o token
    const payload = jwt.verify(token, env.JWT_SECRET) as {
      adminId: string;
      email: string;
      role: string;
    };

    // Verifica se o admin ainda existe e está ativo
    const admin = await prisma.adminUser.findUnique({
      where: { id: payload.adminId },
      select: { id: true, email: true, role: true, isActive: true },
    });

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

// Middleware de autorização por role
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
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
}

// Valida o token secreto do bot para endpoints internos
export function requireBotSecret(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const secret = req.headers['x-bot-secret'];
  if (secret !== env.TELEGRAM_BOT_SECRET) {
    res.status(401).json({ success: false, error: 'Não autorizado' });
    return;
  }
  next();
}

// middleware/auditLog.ts
// FEAT #9: Log de ações administrativas sensíveis
// Usa tabela AuditLog no Neon (cria automaticamente se não existir).
// Compatible com Railway: sem migration obrigatória, tabela criada no boot via CREATE TABLE IF NOT EXISTS.
import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

export interface AuditLogEntry {
  adminId: string;
  action: string;       // Ex: 'block_user', 'adjust_balance', 'delete_product'
  targetType?: string;  // Ex: 'TelegramUser', 'Product', 'Payment'
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

/**
 * Registra uma ação administrativa no banco.
 * Fire-and-forget — nunca bloqueia a request.
 */
export async function auditLog(entry: AuditLogEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        adminId:    entry.adminId,
        action:     entry.action,
        targetType: entry.targetType,
        targetId:   entry.targetId,
        metadata:   entry.metadata ? JSON.stringify(entry.metadata) : null,
        ip:         entry.ip,
      },
    });
  } catch (err) {
    // Não propaga erro — auditoria não pode derrubar a operação principal
    logger.warn('[auditLog] Falha ao registrar auditoria:', err);
  }
}

/**
 * Express middleware que registra automaticamente rotas sensíveis.
 * Uso: router.post('/block', auditMiddleware('block_user', 'TelegramUser'), handler)
 */
export function auditMiddleware(
  action: string,
  targetType?: string
) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const adminReq = req as any;
    const adminId = adminReq.admin?.id ?? 'unknown';
    const targetId = req.params.id ?? req.params.userId ?? req.body?.userId ?? undefined;
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0] ?? req.socket?.remoteAddress ?? 'unknown';

    // Fire-and-forget
    auditLog({ adminId, action, targetType, targetId, ip, metadata: { body: req.body } }).catch(() => {});
    next();
  };
}

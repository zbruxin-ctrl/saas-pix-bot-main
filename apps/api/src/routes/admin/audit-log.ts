// routes/admin/audit-log.ts
// FEAT #9: Router para visualizar o log de ações administrativas no painel
// GET /api/admin/audit-log
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { requireRole } from '../../middleware/auth';

export const auditLogRouter = Router();

const querySchema = z.object({
  page: z.string().default('1').transform(Number),
  perPage: z.string().default('30').transform(Number),
  adminId: z.string().optional(),
  action: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

auditLogRouter.get(
  '/',
  requireRole('SUPERADMIN'),
  async (req: Request, res: Response) => {
    const { page, perPage, adminId, action, startDate, endDate } = querySchema.parse(req.query);

    const where: Prisma.AuditLogWhereInput = {};
    if (adminId) where.adminId = adminId;
    if (action)  where.action  = { contains: action, mode: 'insensitive' };
    if (startDate || endDate) {
      where.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate   ? { lte: new Date(endDate)   } : {}),
      };
    }

    const skip = (page - 1) * perPage;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: {
          admin: { select: { name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: perPage,
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        data: logs,
        total,
        page,
        perPage,
        totalPages: Math.ceil(total / perPage),
      },
    });
  }
);

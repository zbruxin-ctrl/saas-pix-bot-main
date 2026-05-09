// routes/admin/kyc.ts
// Rota admin que expõe os logs do KYC detector para o painel no localhost.
//
// GET  /api/admin/kyc/logs?limit=50&provider=socure|veriff
// GET  /api/admin/kyc/logs/stats
// POST /api/admin/kyc/logs/clear  (SUPERADMIN apenas)

import { Router, Response } from 'express';
import { requireAuth, requireRole, AuthenticatedRequest } from '../../middleware/auth';
import { getKycLogs, clearKycLogs } from '../../lib/kycLogStore';

export const adminKycRouter = Router();

// GET /api/admin/kyc/logs
adminKycRouter.get(
  '/logs',
  requireAuth,
  requireRole('ADMIN', 'SUPERADMIN'),
  (req: AuthenticatedRequest, res: Response) => {
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
    const provider = req.query.provider as 'socure' | 'veriff' | undefined;
    const logs = getKycLogs(limit, provider);
    res.json({ success: true, total: logs.length, data: logs });
  }
);

// GET /api/admin/kyc/logs/stats
adminKycRouter.get(
  '/logs/stats',
  requireAuth,
  requireRole('ADMIN', 'SUPERADMIN'),
  (_req: AuthenticatedRequest, res: Response) => {
    const all = getKycLogs(200);

    const byProvider = all.reduce<Record<string, number>>((acc, l) => {
      acc[l.provider] = (acc[l.provider] || 0) + 1;
      return acc;
    }, {});

    const byStatus = all.reduce<Record<string, number>>((acc, l) => {
      acc[l.status] = (acc[l.status] || 0) + 1;
      return acc;
    }, {});

    const lastEvent = all[0] || null;

    res.json({
      success: true,
      data: {
        total: all.length,
        byProvider,
        byStatus,
        lastEvent,
      },
    });
  }
);

// POST /api/admin/kyc/logs/clear
adminKycRouter.post(
  '/logs/clear',
  requireAuth,
  requireRole('SUPERADMIN'),
  (_req: AuthenticatedRequest, res: Response) => {
    clearKycLogs();
    res.json({ success: true, message: 'Logs KYC limpos.' });
  }
);

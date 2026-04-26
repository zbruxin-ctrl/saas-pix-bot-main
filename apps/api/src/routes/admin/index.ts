// routes/admin/index.ts
// FIX B3/S4: requireAuth no router pai + requireRole em CADA sub-router
// WALLET: registra adminWalletRouter em /wallet
import { Router, Response } from 'express';
import { requireAuth, requireRole, AuthenticatedRequest } from '../../middleware/auth';
import { adminProductsRouter } from './adminProducts';
import { adminDashboardRouter } from './dashboard';
import { adminPaymentsRouter } from './payments';
import { adminUsersRouter } from './users';
import { adminOrdersRouter } from './orders';
import { adminWalletRouter } from './adminWallet';

const router = Router();

// Camada 1: todo /api/admin requer JWT válido
router.use(requireAuth);

// /me: qualquer admin autenticado pode ver seus próprios dados
router.get('/me', (req: AuthenticatedRequest, res: Response) => {
  res.json({ success: true, data: req.admin });
});

// Camada 2: cada sub-router tem requireRole próprio (defense-in-depth)
router.use('/dashboard', requireRole('ADMIN', 'SUPERADMIN'), adminDashboardRouter);
router.use('/payments', adminPaymentsRouter);                          // requireRole interno
router.use('/products', adminProductsRouter);                          // requireRole interno
router.use('/users', requireRole('SUPERADMIN'), adminUsersRouter);
router.use('/orders', requireRole('ADMIN', 'SUPERADMIN'), adminOrdersRouter);
router.use('/wallet', requireRole('ADMIN', 'SUPERADMIN'), adminWalletRouter); // requireRole adicional interno p/ SUPERADMIN

export default router;

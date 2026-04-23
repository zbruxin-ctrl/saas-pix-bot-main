// Router principal do painel admin — agrupa todas as rotas protegidas
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';
import { adminDashboardRouter } from './dashboard';
import { adminPaymentsRouter } from './payments';
import { adminProductsRouter } from './products';
import { adminUsersRouter } from './users';

export const adminRouter = Router();

// Todas as rotas abaixo exigem JWT válido
adminRouter.use(requireAuth);

adminRouter.use('/dashboard', adminDashboardRouter);
adminRouter.use('/payments',  adminPaymentsRouter);
adminRouter.use('/products',  adminProductsRouter);
adminRouter.use('/users',     adminUsersRouter);

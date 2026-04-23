<<<<<<< HEAD
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth';

import { adminDashboardRouter } from './dashboard';
import { adminPaymentsRouter } from './payments';
import { adminProductsRouter } from './products';
import { adminUsersRouter } from './users';

const router = Router();

router.use(requireAuth);

router.use('/dashboard', adminDashboardRouter);
router.use('/payments', adminPaymentsRouter);
router.use('/products', adminProductsRouter);
router.use('/users', adminUsersRouter);

export default router;
=======
// Router principal do painel admin
// Agrupa todas as rotas protegidas do admin
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { adminDashboardRouter } from './admin/dashboard';
import { adminPaymentsRouter } from './admin/payments';
import { adminProductsRouter } from './admin/products';
import { adminUsersRouter } from './admin/users';

export const adminRouter = Router();

// Todas as rotas do admin exigem autenticação
adminRouter.use(requireAuth);

adminRouter.use('/dashboard', adminDashboardRouter);
adminRouter.use('/payments', adminPaymentsRouter);
adminRouter.use('/products', adminProductsRouter);
adminRouter.use('/users', adminUsersRouter);
>>>>>>> a4ba2a08fda8eebc6f3ab2989f5f9326189aee05

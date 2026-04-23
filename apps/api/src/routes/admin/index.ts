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
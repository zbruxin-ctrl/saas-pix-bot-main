import { Router } from 'express';
import { adminProductsRouter } from './products';

const router = Router();

// Rotas de admin
router.use('/products', adminProductsRouter);

export default router;
// routes/admin/adminProducts.ts
import { Router, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { requireRole, AuthenticatedRequest } from '../../middleware/auth';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

export const adminProductsRouter = Router();

const productSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().min(5).max(500),
  price: z.number().positive().max(99999),
  deliveryType: z.enum(['TEXT', 'LINK', 'FILE_MEDIA', 'ACCOUNT']),
  deliveryContent: z.string().min(1),
  isActive: z.boolean().default(true),
  stock: z.number().int().positive().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

// ─── Multer: upload local temporário (fallback sem cloud storage) ─────────────
const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    const allowed = /image|video|application\/pdf|application\/zip|application\/octet-stream/;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de arquivo não permitido'));
  },
});

// ─── Produtos ─────────────────────────────────────────────────────────────────

adminProductsRouter.get('/', async (_req, res: Response) => {
  const products = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ success: true, data: products.map((p) => ({ ...p, price: Number(p.price) })) });
});

adminProductsRouter.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  const product = await prisma.product.findUnique({ where: { id: req.params.id } });
  if (!product) return res.status(404).json({ success: false, error: 'Produto não encontrado' });
  res.json({ success: true, data: { ...product, price: Number(product.price) } });
});

adminProductsRouter.post(
  '/',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const data = productSchema.parse(req.body);
    const product = await prisma.product.create({
      data: { ...data, metadata: (data.metadata as Prisma.InputJsonValue) ?? undefined },
    });
    res.status(201).json({ success: true, data: { ...product, price: Number(product.price) } });
  }
);

adminProductsRouter.put(
  '/:id',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const data = productSchema.partial().parse(req.body);
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: { ...data, metadata: (data.metadata as Prisma.InputJsonValue) ?? undefined },
    });
    res.json({ success: true, data: { ...product, price: Number(product.price) } });
  }
);

adminProductsRouter.delete(
  '/:id',
  requireRole('SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    await prisma.product.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ success: true });
  }
);

// ─── Mídias de configuração do produto (medias-config) ───────────────────────
// Armazenadas em product.metadata.medias — sem tabela própria por ora.
// GET /api/admin/products/:id/medias-config
adminProductsRouter.get(
  '/:id/medias-config',
  async (req: AuthenticatedRequest, res: Response) => {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      select: { metadata: true },
    });
    if (!product) return res.status(404).json({ success: false, error: 'Produto não encontrado' });

    const meta = product.metadata as Record<string, unknown> | null;
    const medias = Array.isArray(meta?.medias) ? meta!.medias : [];
    res.json({ success: true, data: medias });
  }
);

// PUT /api/admin/products/:id/medias-config
const mediasConfigSchema = z.object({
  medias: z.array(
    z.object({
      url: z.string().min(1),
      mediaType: z.enum(['IMAGE', 'VIDEO', 'FILE']),
      caption: z.string().max(500).optional(),
    })
  ),
});

adminProductsRouter.put(
  '/:id/medias-config',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const { medias } = mediasConfigSchema.parse(req.body);

    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      select: { metadata: true },
    });
    if (!product) return res.status(404).json({ success: false, error: 'Produto não encontrado' });

    const existingMeta = (product.metadata as Record<string, unknown>) ?? {};
    const updatedMeta: Prisma.InputJsonValue = { ...existingMeta, medias };

    await prisma.product.update({
      where: { id: req.params.id },
      data: { metadata: updatedMeta },
    });

    res.json({ success: true, data: medias });
  }
);

// ─── Upload de mídia (armazenamento local temporário) ─────────────────────────
// POST /api/admin/upload
// Nota: em produção substitua pelo upload direto para S3/R2/Supabase Storage.
adminProductsRouter.post(
  '/upload',
  requireRole('ADMIN', 'SUPERADMIN'),
  upload.single('file'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'Nenhum arquivo enviado' });
      return;
    }

    // Gera URL pública usando a API_URL configurada no ambiente
    const baseUrl = process.env.API_URL ?? '';
    const url = `${baseUrl}/uploads/${req.file.filename}`;

    res.status(201).json({ success: true, data: { url, filename: req.file.filename } });
  }
);

// ─── StockItem CRUD ───────────────────────────────────────────────────────────
const stockItemSchema = z.object({
  content: z.string().min(1),
});

// GET /api/admin/products/:productId/stock-items
adminProductsRouter.get(
  '/:productId/stock-items',
  async (req: AuthenticatedRequest, res: Response) => {
    const items = await prisma.stockItem.findMany({
      where: { productId: req.params.productId },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ success: true, data: items });
  }
);

// POST /api/admin/products/:productId/stock-items
adminProductsRouter.post(
  '/:productId/stock-items',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const { content } = stockItemSchema.parse(req.body);
    const item = await prisma.stockItem.create({
      data: { productId: req.params.productId, content, status: 'AVAILABLE' },
    });
    res.status(201).json({ success: true, data: item });
  }
);

// DELETE /api/admin/products/stock-items/:itemId
// FIX: movido para DEPOIS das rotas /:productId/* para evitar conflito de params no Express
adminProductsRouter.delete(
  '/stock-items/:itemId',
  requireRole('SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    await prisma.stockItem.delete({ where: { id: req.params.itemId } });
    res.json({ success: true });
  }
);

// ─── Mídias de entrega por pedido ─────────────────────────────────────────────
const mediaSchema = z.object({
  url: z.string().url(),
  mediaType: z.enum(['IMAGE', 'VIDEO', 'FILE']),
  caption: z.string().max(500).optional(),
  sortOrder: z.number().int().default(0),
});

adminProductsRouter.get('/orders/:orderId/medias', async (req: AuthenticatedRequest, res: Response) => {
  const medias = await prisma.deliveryMedia.findMany({
    where: { orderId: req.params.orderId },
    orderBy: { sortOrder: 'asc' },
  });
  res.json({ success: true, data: medias });
});

adminProductsRouter.post(
  '/orders/:orderId/medias',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const data = mediaSchema.parse(req.body);
    const media = await prisma.deliveryMedia.create({
      data: { orderId: req.params.orderId, ...data },
    });
    res.status(201).json({ success: true, data: media });
  }
);

adminProductsRouter.delete(
  '/orders/medias/:mediaId',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    await prisma.deliveryMedia.delete({ where: { id: req.params.mediaId } });
    res.json({ success: true });
  }
);

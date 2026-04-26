// routes/admin/adminProducts.ts
// FIX BUG2: rotas estáticas (/stock, /orders/:id/medias, /orders/medias/:id) ANTES de /:id
// SORT: PATCH /reorder para drag-and-drop no painel admin
// SORT: GET / agora ordena por sortOrder asc, createdAt asc
import { Router, Response } from 'express';
import { z } from 'zod';
import { Prisma, StockItemStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { requireRole, AuthenticatedRequest } from '../../middleware/auth';
import multer, { FileFilterCallback, StorageEngine } from 'multer';
import { Request } from 'express';
import path from 'path';
import fs from 'fs';
import { logger } from '../../lib/logger';

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

const listQuerySchema = z.object({
  page: z.string().default('1').transform(Number),
  perPage: z.string().default('20').transform(Number),
});

const reorderSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      sortOrder: z.number().int().min(0),
    })
  ).min(1),
});

// ─── Multer ───────────────────────────────────────────────────────────

const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage: StorageEngine = multer.diskStorage({
  destination: (_req: Request, _file: Express.Multer.File, cb: (error: Error | null, destination: string) => void) =>
    cb(null, uploadDir),
  filename: (_req: Request, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
    const allowed = /image|video|application\/pdf|application\/zip|application\/octet-stream/;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de arquivo não permitido'));
  },
});

async function uploadToCloudinary(
  filePath: string,
  originalname: string,
  mimetype: string
): Promise<string | null> {
  const cloudinaryUrl = process.env.CLOUDINARY_URL;
  if (!cloudinaryUrl) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { v2: cloudinary } = require('cloudinary');
    const isVideo = /video/i.test(mimetype);
    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: isVideo ? 'video' : 'auto',
      public_id: `saas-pix/${Date.now()}-${path.basename(originalname, path.extname(originalname))}`,
      overwrite: false,
    });
    return result.secure_url as string;
  } catch (err) {
    logger.warn('[Cloudinary] Falha no upload, usando URL local como fallback:', err);
    return null;
  }
}

/** Tipos FIFO que usam StockItems como fila */
const FIFO_TYPES = ['TEXT', 'LINK', 'ACCOUNT'];

async function syncFifoItems(
  productId: string,
  items: string[],
  deliveryType: string
): Promise<boolean> {
  if (!FIFO_TYPES.includes(deliveryType)) return false;
  const valid = items.map((v) => v.trim()).filter(Boolean);
  if (valid.length === 0) return false;

  await prisma.$transaction(async (tx) => {
    await tx.stockItem.deleteMany({
      where: { productId, status: StockItemStatus.AVAILABLE },
    });
    await tx.stockItem.createMany({
      data: valid.map((content) => ({
        productId,
        content,
        status: StockItemStatus.AVAILABLE,
      })),
    });
    await tx.product.update({
      where: { id: productId },
      data: { deliveryContent: '__FIFO__' },
    });
  });

  logger.info(`[adminProducts] ${valid.length} StockItems FIFO sincronizados para produto=${productId}`);
  return true;
}

// ─── Upload ───────────────────────────────────────────────────────────────────

adminProductsRouter.post(
  '/upload',
  requireRole('ADMIN', 'SUPERADMIN'),
  upload.single('file'),
  async (req: AuthenticatedRequest & { file?: Express.Multer.File }, res: Response) => {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'Nenhum arquivo enviado' });
      return;
    }
    let url: string;
    const cloudinaryResult = await uploadToCloudinary(
      req.file.path,
      req.file.originalname,
      req.file.mimetype
    );
    if (cloudinaryResult) {
      fs.unlink(req.file.path, () => {});
      url = cloudinaryResult;
    } else {
      const baseUrl = process.env.API_URL ?? '';
      url = `${baseUrl}/uploads/${req.file.filename}`;
    }
    res.status(201).json({ success: true, data: { url, filename: req.file.filename } });
  }
);

// ─── Listagem (ordenada por sortOrder) ─────────────────────────────────────────────

adminProductsRouter.get(
  '/',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const { page, perPage } = listQuerySchema.parse(req.query);
    const skip = (page - 1) * perPage;
    const [products, total] = await Promise.all([
      prisma.product.findMany({
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        skip,
        take: perPage,
      }),
      prisma.product.count(),
    ]);
    res.json({
      success: true,
      data: {
        data: products.map((p) => ({ ...p, price: Number(p.price) })),
        total,
        page,
        perPage,
        totalPages: Math.ceil(total / perPage),
      },
    });
  }
);

// ─── PATCH /reorder ───────────────────────────────────────────────────────────────

adminProductsRouter.patch(
  '/reorder',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const { items } = reorderSchema.parse(req.body);

    await prisma.$transaction(
      items.map(({ id, sortOrder }) =>
        prisma.product.update({
          where: { id },
          data: { sortOrder },
        })
      )
    );

    logger.info(`[adminProducts] Ordem de ${items.length} produtos atualizada`);
    res.json({ success: true, message: 'Ordem atualizada com sucesso' });
  }
);

// ─── GET /stock — ANTES de /:id para não ser capturado como /:id="stock" ────────

adminProductsRouter.get(
  '/stock',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (_req: AuthenticatedRequest, res: Response) => {
    const products = await prisma.product.findMany({
      where: { isActive: true },
      select: { id: true, name: true, stock: true, _count: { select: { stockItems: true } } },
    });
    const result = await Promise.all(
      products.map(async (p) => {
        if (p._count.stockItems > 0) {
          const available = await prisma.stockItem.count({ where: { productId: p.id, status: 'AVAILABLE' } });
          const reserved = await prisma.stockItem.count({ where: { productId: p.id, status: 'RESERVED' } });
          return { productId: p.id, productName: p.name, mode: 'FIFO' as const, available, reserved, total: p._count.stockItems, stockField: null };
        }
        return { productId: p.id, productName: p.name, mode: p.stock !== null ? ('NUMERIC' as const) : ('UNLIMITED' as const), available: p.stock, reserved: null, total: null, stockField: p.stock };
      })
    );
    res.json({ success: true, data: result });
  }
);

// ─── Rotas de mídia por pedido — ANTES de /:id para evitar captura pelo Express ──

const mediaSchema = z.object({
  url: z.string().url(),
  mediaType: z.enum(['IMAGE', 'VIDEO', 'FILE']),
  caption: z.string().max(500).optional(),
  sortOrder: z.number().int().default(0),
});

adminProductsRouter.get(
  '/orders/:orderId/medias',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const medias = await prisma.deliveryMedia.findMany({ where: { orderId: req.params.orderId }, orderBy: { sortOrder: 'asc' } });
    res.json({ success: true, data: medias });
  }
);

adminProductsRouter.post(
  '/orders/:orderId/medias',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const data = mediaSchema.parse(req.body);
    const media = await prisma.deliveryMedia.create({ data: { orderId: req.params.orderId, ...data } });
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

// ─── GET /:id — somente após todas as rotas estáticas ────────────────────────

adminProductsRouter.get(
  '/:id',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: {
        stockItems: {
          where: { status: StockItemStatus.AVAILABLE },
          orderBy: { createdAt: 'asc' },
          select: { id: true, content: true, status: true, createdAt: true },
        },
      },
    });
    if (!product) {
      res.status(404).json({ success: false, error: 'Produto não encontrado' });
      return;
    }
    res.json({ success: true, data: { ...product, price: Number(product.price) } });
  }
);

// ─── POST / ──────────────────────────────────────────────────────────────────────

adminProductsRouter.post(
  '/',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const data = productSchema.parse(req.body);
    const isFifo = FIFO_TYPES.includes(data.deliveryType);

    const productData = {
      ...data,
      deliveryContent: isFifo ? '__FIFO__' : data.deliveryContent,
      metadata: (data.metadata as Prisma.InputJsonValue) ?? undefined,
    };

    const product = await prisma.product.create({ data: productData });

    if (isFifo) {
      try {
        const parsed = JSON.parse(data.deliveryContent);
        if (Array.isArray(parsed) && parsed.length > 0) {
          await syncFifoItems(product.id, parsed.map(String), data.deliveryType);
        }
      } catch {
        if (data.deliveryContent && data.deliveryContent !== '__FIFO__') {
          await syncFifoItems(product.id, [data.deliveryContent], data.deliveryType);
        }
      }
    }

    res.status(201).json({ success: true, data: { ...product, price: Number(product.price) } });
  }
);

// ─── PUT /:id ─────────────────────────────────────────────────────────────────────

adminProductsRouter.put(
  '/:id',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const data = productSchema.partial().parse(req.body);
    const isFifo = data.deliveryType ? FIFO_TYPES.includes(data.deliveryType) : false;

    const updateData: Prisma.ProductUpdateInput = {
      ...data,
      metadata: (data.metadata as Prisma.InputJsonValue) ?? undefined,
    };

    if (isFifo) {
      updateData.deliveryContent = '__FIFO__';
    }

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: updateData,
    });

    if (isFifo && data.deliveryContent && data.deliveryContent !== '__FIFO__') {
      try {
        const parsed = JSON.parse(data.deliveryContent);
        if (Array.isArray(parsed)) {
          await syncFifoItems(product.id, parsed.map(String), data.deliveryType!);
        }
      } catch {
        if (data.deliveryContent) {
          await syncFifoItems(product.id, [data.deliveryContent], data.deliveryType!);
        }
      }
    }

    res.json({ success: true, data: { ...product, price: Number(product.price) } });
  }
);

// ─── DELETE /:id ────────────────────────────────────────────────────────────────

adminProductsRouter.delete(
  '/:id',
  requireRole('SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    await prisma.product.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ success: true });
  }
);

// ─── Mídias de configuração do produto ───────────────────────────────────────────────

adminProductsRouter.get(
  '/:id/medias-config',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const product = await prisma.product.findUnique({ where: { id: req.params.id }, select: { metadata: true } });
    if (!product) { res.status(404).json({ success: false, error: 'Produto não encontrado' }); return; }
    const meta = product.metadata as Record<string, unknown> | null;
    const medias = Array.isArray(meta?.medias) ? meta!.medias : [];
    res.json({ success: true, data: medias });
  }
);

const mediasConfigSchema = z.object({
  medias: z.array(z.object({
    url: z.string().min(1),
    mediaType: z.enum(['IMAGE', 'VIDEO', 'FILE']),
    caption: z.string().max(500).optional(),
  })),
});

adminProductsRouter.put(
  '/:id/medias-config',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const { medias } = mediasConfigSchema.parse(req.body);
    const product = await prisma.product.findUnique({ where: { id: req.params.id }, select: { metadata: true } });
    if (!product) { res.status(404).json({ success: false, error: 'Produto não encontrado' }); return; }
    const existingMeta = (product.metadata as Record<string, unknown>) ?? {};
    const updatedMeta: Prisma.InputJsonValue = { ...existingMeta, medias };
    await prisma.product.update({ where: { id: req.params.id }, data: { metadata: updatedMeta } });
    res.json({ success: true, data: medias });
  }
);

// ─── StockItem CRUD ────────────────────────────────────────────────────────────────

const stockItemSchema = z.object({ content: z.string().min(1) });

adminProductsRouter.get(
  '/:productId/stock-items',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    const items = await prisma.stockItem.findMany({
      where: { productId: req.params.productId, status: StockItemStatus.AVAILABLE },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ success: true, data: items });
  }
);

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

adminProductsRouter.delete(
  '/stock-items/:itemId',
  requireRole('SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    await prisma.stockItem.delete({ where: { id: req.params.itemId } });
    res.json({ success: true });
  }
);

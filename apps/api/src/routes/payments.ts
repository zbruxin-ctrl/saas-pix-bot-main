// Rotas de pagamento (usadas pelo bot)
// FIX BUG8: GET /products movido para ANTES de GET /:id/status
// FIX BUG1: POST /:id/cancel
// FIX STOCK-DISPLAY: /products retorna availableStock calculado corretamente
// WALLET: POST /deposit e GET /balance
// SORT: /products ordena por sortOrder, depois createdAt
// OPT #5 v2: 1 groupBy para todos os COUNTs
// OPT #11: /balance resolve com include em 1 query
// FEATURE: GET /orders?telegramId=xxx
// FEAT-MAINT: GET /bot-config expe maintenance_mode + maintenance_message + isBlocked
//   POST /create e POST /deposit retornam 503 quando maintenance_mode=true
//   POST /create e POST /deposit retornam 403 quando usuario esta bloqueado
// FEAT-BLOCKED: /bot-config inclui isBlocked do usuario (por telegramId query param)
// SEC FIX #6: GET /:id/status e POST /:id/cancel agora exigem telegramId e
//   verificam ownership antes de retornar/cancelar (impede consulta de pagamentos alheios)
// FIX-COUPON: couponCode e referralCode adicionados ao createPaymentSchema
// FIX-ZOD: parse() envolto em try/catch para retornar 400 em vez de 500
// FEAT-SUPPORT: /bot-config agora inclui supportPhone lido do painel admin (support_phone)
// FIX-WELCOME: /bot-config inclui welcomeMessage lido do painel admin (welcome_message)
// FIX-ROUTES: createDepositPayment → createDeposit; cancelPayment result.reason → result.message
// FIX-QTY-SCHEMA: quantity adicionado ao createPaymentSchema (era descartado pelo Zod)
// FIX-DELIVERY-ITEMS: GET /:id/delivered-items retorna conteudo real dos StockItems entregues
// FIX-BOT-SOURCE: botSource adicionado ao createPaymentSchema ('telegram' | 'whatsapp')
//   Permite que a API saiba qual bot originou o pagamento e ajuste o comportamento de entrega.
// FIX-DELIVERY-READY: ready=true somente quando TODOS os itens (payment.qty) estão DELIVERED.
//   Antes: ready=true com 1 item — bot exibia apenas 1 item em pedidos com qty>1.
// FIX-BUILD: campo correto é `qty` (não `quantity`) no model Payment do Prisma.
// FIX-CANCEL-ERROR-FIELD: POST /:id/cancel usava campo `message` em respostas de erro 400/403.
//   O interceptor Axios do bot só lê `response.data.error` — resultado: a mensagem real
//   se perdia e o bot mostrava genérico 'Erro ao cancelar pagamento.'
//   Corrigido: todas as respostas de erro do endpoint agora usam o campo `error`.
// FIX-CANCEL-DATA: POST /:id/cancel retornava { success:true, message } em caso de sucesso.
//   O apiClient lê data.data!, que era undefined — result.cancelled ficava undefined (falsy)
//   → bot caia no catch → '❌ Erro ao cancelar pagamento.' mesmo com HTTP 200.
//   Corrigido: sucesso agora retorna { success:true, data:{ cancelled:true, message } }.
// FIX-WA-DELIVERY: GET /:id/delivered-items agora inclui `confirmationMessage` e `medias`
//   do produto na resposta. O bot do WhatsApp usava apenas `items` (conteúdo bruto dos
//   StockItems), ignorando a mensagem personalizada e as mídias configuradas no produto.
//   confirmationMessage: string pronta para envio (resolve {{produto}} e {{conteudo}}).
//   medias: array de { url, mediaType, caption } para o bot enviar na sequência.
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { StockItemStatus, DeliveryType } from '@prisma/client';
import { paymentService } from '../services/paymentService';
import { paymentRateLimit } from '../middleware/rateLimit';
import { requireBotSecret } from '../middleware/auth';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { getSetting } from './admin/settings';

export const paymentsRouter = Router();

const createPaymentSchema = z.object({
  telegramId: z.string().min(1),
  productId: z.string().min(1),
  quantity: z.number().int().min(1).max(100).optional(),  // FIX-QTY-SCHEMA
  firstName: z.string().optional(),
  username: z.string().optional(),
  paymentMethod: z.string().optional(),
  couponCode: z.string().optional(),
  referralCode: z.string().optional(),
  // FIX-BOT-SOURCE: qual bot originou este pagamento
  // 'telegram' → entrega via mensagem Telegram (comportamento padrão)
  // 'whatsapp' → entrega via polling GET /delivered-items (não envia msg Telegram)
  // ausente/null → retrocompatível, tratado como 'telegram'
  botSource: z.enum(['telegram', 'whatsapp']).optional(),
});

const createDepositSchema = z.object({
  telegramId: z.string().min(1),
  amount: z.number().min(1).max(10000),
  firstName: z.string().optional(),
  username: z.string().optional(),
});

// ─── Helpers ────────────────────────────────────────────────

async function isMaintenanceActive(): Promise<{ active: boolean; message: string }> {
  const [mode, msg] = await Promise.all([
    getSetting('maintenance_mode'),
    getSetting('maintenance_message'),
  ]);
  return { active: mode === 'true', message: msg };
}

async function isUserBlocked(telegramId: string): Promise<boolean> {
  const user = await prisma.telegramUser.findUnique({
    where: { telegramId },
    select: { isBlocked: true },
  });
  return user?.isBlocked ?? false;
}

/**
 * SEC FIX #6: Verifica se o pagamento pertence ao telegramId informado.
 */
async function getPaymentIfOwner(
  paymentId: string,
  telegramId: string
): Promise<{ id: string } | null> {
  const user = await prisma.telegramUser.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return null;

  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, telegramUserId: user.id },
    select: { id: true },
  });
  return payment ?? null;
}

// ─── FIX-WA-DELIVERY: helpers para montar confirmationMessage e medias ─────────

type MediaEntry = { url: string; mediaType: 'IMAGE' | 'VIDEO' | 'FILE'; caption?: string };

function buildConfirmationMessageForWhatsApp(
  product: { name: string; deliveryType: DeliveryType; metadata: unknown },
  contents: string[]
): string {
  const meta = product.metadata as Record<string, unknown> | null;
  const custom = meta?.confirmationMessage as string | undefined;
  const content = contents.join('\n');

  if (custom && custom.trim()) {
    return custom
      .replace(/\{\{produto\}\}/g, product.name)
      .replace(/\{\{conteudo\}\}/g, content);
  }

  if (contents.length > 1) {
    const items = contents.map((c) => `\n${c}`).join('');
    return (
      `✅ *Compra realizada com sucesso!*\n` +
      `📦 *${product.name}* (${contents.length}x)` +
      items +
      `\n\n⚠️ _Os links são de uso único e não realizamos trocas._`
    );
  }

  switch (product.deliveryType) {
    case DeliveryType.LINK:
      return (
        `🎉 *Pagamento confirmado!*\n\n` +
        `📦 *Produto:* ${product.name}\n\n` +
        `🔗 Acesse através do link abaixo:\n${content}\n\n` +
        `⚠️ _Guarde este link em local seguro._`
      );
    default:
      return (
        `🎉 *Pagamento confirmado!*\n\n` +
        `📦 *Produto:* ${product.name}\n\n` +
        `${content}`
      );
  }
}

function getProductMedias(metadata: unknown): MediaEntry[] {
  const meta = metadata as Record<string, unknown> | null;
  if (!meta?.medias || !Array.isArray(meta.medias)) return [];
  return meta.medias as MediaEntry[];
}

// ─── Rotas estáticas PRIMEIRO ───────────────────────────────────────────────────────────

// GET /api/payments/bot-config?telegramId=xxx
paymentsRouter.get(
  '/bot-config',
  requireBotSecret,
  async (req: Request, res: Response) => {
    try {
      const telegramId = req.query.telegramId as string | undefined;

      const [maintenanceMode, maintenanceMessage, supportPhone, welcomeMessage, blocked] = await Promise.all([
        getSetting('maintenance_mode'),
        getSetting('maintenance_message'),
        getSetting('support_phone'),
        getSetting('welcome_message'),
        telegramId ? isUserBlocked(telegramId) : Promise.resolve(false),
      ]);

      res.json({
        success: true,
        data: {
          maintenanceMode: maintenanceMode === 'true',
          maintenanceMessage,
          supportPhone,
          isBlocked: blocked,
          welcomeMessage,
        },
      });
    } catch (err) {
      logger.error('[bot-config] Erro:', err);
      res.json({
        success: true,
        data: {
          maintenanceMode: false,
          maintenanceMessage: '',
          supportPhone: '',
          isBlocked: false,
          welcomeMessage: '',
        },
      });
    }
  }
);

// POST /api/payments/create
paymentsRouter.post(
  '/create',
  requireBotSecret,
  paymentRateLimit,
  async (req: Request, res: Response) => {
    let data: z.infer<typeof createPaymentSchema>;
    try {
      data = createPaymentSchema.parse(req.body);
    } catch (err) {
      res.status(400).json({ success: false, error: 'Dados inválidos na requisição.' });
      return;
    }

    const { active, message } = await isMaintenanceActive();
    if (active) {
      res.status(503).json({ success: false, error: message || 'Estamos em manutenção. Voltamos em breve!' });
      return;
    }
    const blocked = await isUserBlocked(data.telegramId);
    if (blocked) {
      res.status(403).json({ success: false, error: 'Sua conta está suspensa. Entre em contato com o suporte.' });
      return;
    }
    // FIX-QTY-SCHEMA: repassa quantity como qty para o service
    // FIX-BOT-SOURCE: repassa botSource para o service
    const result = await paymentService.createPayment({
      ...data,
      qty: data.quantity,
      botSource: data.botSource,
    });
    logger.info(`Pagamento criado via API: ${result.paymentId}`);
    res.status(201).json({ success: true, data: result });
  }
);

// POST /api/payments/deposit
paymentsRouter.post(
  '/deposit',
  requireBotSecret,
  paymentRateLimit,
  async (req: Request, res: Response) => {
    let data: z.infer<typeof createDepositSchema>;
    try {
      data = createDepositSchema.parse(req.body);
    } catch (err) {
      res.status(400).json({ success: false, error: 'Dados inválidos na requisição.' });
      return;
    }

    const { active, message } = await isMaintenanceActive();
    if (active) {
      res.status(503).json({ success: false, error: message || 'Estamos em manutenção. Voltamos em breve!' });
      return;
    }
    const blocked = await isUserBlocked(data.telegramId);
    if (blocked) {
      res.status(403).json({ success: false, error: 'Sua conta está suspensa. Entre em contato com o suporte.' });
      return;
    }
    const result = await paymentService.createDeposit(data);
    logger.info(`[Deposit] PIX de depósito criado via API: ${result.paymentId}`);
    res.status(201).json({ success: true, data: result });
  }
);

// GET /api/payments/balance?telegramId=xxx
paymentsRouter.get(
  '/balance',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const { telegramId } = req.query as { telegramId?: string };
    if (!telegramId) {
      res.status(400).json({ success: false, error: 'telegramId é obrigatório' });
      return;
    }

    const user = await prisma.telegramUser.findUnique({
      where: { telegramId },
      select: {
        id: true,
        balance: true,
        walletTransactions: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            type: true,
            amount: true,
            description: true,
            paymentId: true,
            createdAt: true,
          },
        },
      },
    });

    if (!user) {
      res.json({ success: true, data: { balance: 0, transactions: [] } });
      return;
    }

    res.json({
      success: true,
      data: {
        balance: Number(user.balance),
        transactions: user.walletTransactions.map((t) => ({
          ...t,
          amount: Number(t.amount),
          createdAt: t.createdAt.toISOString(),
        })),
      },
    });
  }
);

// GET /api/payments/products
paymentsRouter.get(
  '/products',
  requireBotSecret,
  async (_req: Request, res: Response) => {
    const [products, stockCounts] = await Promise.all([
      prisma.product.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          description: true,
          price: true,
          deliveryType: true,
          stock: true,
          sortOrder: true,
          metadata: true,
          _count: { select: { stockItems: true } },
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      prisma.stockItem.groupBy({
        by: ['productId'],
        where: { status: StockItemStatus.AVAILABLE },
        _count: { id: true },
      }),
    ]);

    const stockMap = new Map<string, number>();
    for (const s of stockCounts) {
      stockMap.set(s.productId, s._count.id);
    }

    const productsWithStock = products.map((p) => {
      let availableStock: number | null;
      if (p._count.stockItems > 0) {
        availableStock = stockMap.get(p.id) ?? 0;
      } else if (p.stock !== null) {
        availableStock = p.stock;
      } else {
        availableStock = null;
      }
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        price: Number(p.price),
        deliveryType: p.deliveryType,
        sortOrder: p.sortOrder,
        metadata: p.metadata,
        availableStock,
      };
    });

    const available = productsWithStock.filter(
      (p) => p.availableStock === null || p.availableStock > 0
    );

    res.json({ success: true, data: available });
  }
);

// GET /api/payments/orders?telegramId=xxx
paymentsRouter.get(
  '/orders',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const { telegramId } = req.query as { telegramId?: string };
    if (!telegramId) {
      res.status(400).json({ success: false, error: 'telegramId é obrigatório' });
      return;
    }

    const user = await prisma.telegramUser.findUnique({
      where: { telegramId },
      select: { id: true },
    });

    if (!user) {
      res.json({ success: true, data: [] });
      return;
    }

    const orders = await prisma.order.findMany({
      where: { telegramUserId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        status: true,
        createdAt: true,
        deliveredAt: true,
        product: { select: { name: true } },
        payment: { select: { amount: true, paymentMethod: true } },
      },
    });

    res.json({
      success: true,
      data: orders.map((o) => ({
        id: o.id,
        status: o.status,
        createdAt: o.createdAt.toISOString(),
        deliveredAt: o.deliveredAt ? o.deliveredAt.toISOString() : null,
        productName: o.product?.name ?? 'Produto',
        amount: o.payment ? Number(o.payment.amount) : null,
        paymentMethod: o.payment?.paymentMethod ?? null,
      })),
    });
  }
);

// ─── Rotas dinâmicas DEPOIS das estáticas ─────────────────────────────────────────────────────

// POST /api/payments/:id/cancel
paymentsRouter.post(
  '/:id/cancel',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { telegramId } = req.body as { telegramId?: string };

    if (!telegramId) {
      res.status(400).json({ success: false, error: 'telegramId é obrigatório' });
      return;
    }

    const owned = await getPaymentIfOwner(id, telegramId);
    if (!owned) {
      logger.warn(`[cancel] telegramId ${telegramId} tentou cancelar pagamento ${id} sem ownership`);
      res.status(403).json({ success: false, error: 'Não autorizado: este pagamento não pertence à sua conta.' });
      return;
    }

    const result = await paymentService.cancelPayment(id);
    if (!result.cancelled) {
      res.status(400).json({ success: false, error: result.message });
      return;
    }
    logger.info(`Pagamento ${id} cancelado via bot (telegramId: ${telegramId})`);
    res.json({ success: true, data: { cancelled: true, message: result.message } });
  }
);

// GET /api/payments/:id/status
paymentsRouter.get(
  '/:id/status',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { telegramId } = req.query as { telegramId?: string };

    if (!telegramId) {
      res.status(400).json({ success: false, error: 'telegramId é obrigatório' });
      return;
    }

    const owned = await getPaymentIfOwner(id, telegramId);
    if (!owned) {
      logger.warn(`[status] telegramId ${telegramId} tentou consultar pagamento ${id} sem ownership`);
      res.status(403).json({ success: false, error: 'Não autorizado: este pagamento não pertence à sua conta.' });
      return;
    }

    const status = await paymentService.getPaymentStatus(id);
    res.json({ success: true, data: status });
  }
);

// GET /api/payments/:id/delivered-items?telegramId=xxx
// FIX-DELIVERY-ITEMS: retorna o conteudo real de cada StockItem entregue para este pagamento.
// FIX-DELIVERY-READY: ready=true somente quando TODOS os itens esperados (payment.qty) estão DELIVERED.
// FIX-BUILD: campo é `qty` (não `quantity`) no model Payment do Prisma.
// FIX-WA-DELIVERY: inclui `confirmationMessage` (mensagem personalizada pronta para envio)
//   e `medias` (array de { url, mediaType, caption }) para que o bot do WhatsApp envie
//   a mensagem formatada e os arquivos de mídia do produto, e não apenas o conteúdo bruto.
paymentsRouter.get(
  '/:id/delivered-items',
  requireBotSecret,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { telegramId } = req.query as { telegramId?: string };

    if (!telegramId) {
      res.status(400).json({ success: false, error: 'telegramId é obrigatório' });
      return;
    }

    const owned = await getPaymentIfOwner(id, telegramId);
    if (!owned) {
      res.status(403).json({ success: false, error: 'Não autorizado.' });
      return;
    }

    const [payment, items] = await Promise.all([
      prisma.payment.findUnique({
        where: { id },
        select: {
          qty: true,
          product: {
            select: {
              name: true,
              deliveryType: true,
              metadata: true,
            },
          },
        },
      }),
      prisma.stockItem.findMany({
        where: {
          order: { paymentId: id },
          status: StockItemStatus.DELIVERED,
        },
        select: { content: true },
        orderBy: { updatedAt: 'asc' },
      }),
    ]);

    const expectedQty = payment?.qty ?? 1;
    const ready = items.length >= expectedQty;
    const contents = ready ? items.map((i) => i.content) : [];

    // FIX-WA-DELIVERY: monta confirmationMessage e medias para o bot do WhatsApp
    let confirmationMessage: string | null = null;
    let medias: MediaEntry[] = [];

    if (ready && payment?.product) {
      confirmationMessage = buildConfirmationMessageForWhatsApp(payment.product, contents);
      medias = getProductMedias(payment.product.metadata);
    }

    res.json({
      success: true,
      data: {
        ready,
        items: contents,
        // FIX-WA-DELIVERY: novos campos — null quando ainda não pronto
        confirmationMessage,
        medias,
      },
    });
  }
);

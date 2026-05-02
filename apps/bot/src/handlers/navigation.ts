/**
 * Handlers de navegação: home, produtos, pedidos, ajuda e mensagem de conta bloqueada.
 * PADRÃO: parse_mode HTML em todas as mensagens.
 *
 * FIX-SHOWHELP-EDITORRELY: showHelp migrado para editOrReply() eliminando
 *   duplicação de editMessageText + sendMessage + atualização manual de mainMessageId.
 * FIX-ESCAPEHTML-NUMERIC: escapeHtml() removido de valores numéricos/datas
 *   gerados por toLocaleDateString/toFixed em showOrders.
 */
import { Context, Markup } from 'telegraf';
import { escapeHtml } from '../utils/escape';
import { editOrReply } from '../utils/helpers';
import { getSession, saveSession } from '../services/session';
import { apiClient } from '../services/apiClient';
import { env } from '../config/env';
import type { OrderSummary } from '../services/apiClient';

// ─── Home ──────────────────────────────────────────────────────────────────────────────────────────

export async function showHome(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const session = await getSession(userId);
  const firstName = escapeHtml(ctx.from?.first_name || session.firstName || 'visitante');

  const text =
    `👋 Olá, <b>${firstName}</b>! Bem-vindo!\n\n` +
    `🛒 Aqui você pode adquirir nossos produtos de forma rápida e segura.\n\n` +
    `💳 Aceitamos pagamento via <b>PIX</b> (confirmação instantânea) ou via <b>saldo</b> pré-carregado.\n\n` +
    `Para ver nossos produtos, clique no botão abaixo:`;

  await editOrReply(ctx, text, {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('🛒 Ver Produtos', 'show_products')],
      [Markup.button.callback('💰 Meu Saldo', 'show_balance')],
      [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
      [Markup.button.callback('🎁 Indique e Ganhe', 'show_referral')],
      [Markup.button.callback('❓ Ajuda', 'show_help')],
    ]).reply_markup,
  });
}

// ─── Produtos ────────────────────────────────────────────────────────────────────────────────────

export async function showProducts(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const session = await getSession(userId);
  session.step = 'idle';
  await saveSession(userId, session);

  try {
    const products = await apiClient.getProducts();

    if (!products || products.length === 0) {
      await editOrReply(ctx, '😔 Nenhum produto disponível no momento. Volte em breve!', {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('◀️ Voltar', 'show_home')]]).reply_markup,
      });
      return;
    }

    const buttons = products.map((p) => {
      const esgotado = p.stock != null && p.stock <= 0;
      const stockLabel = esgotado
        ? ' [ESGOTADO]'
        : p.stock != null
          ? ` (${p.stock} restantes)`
          : '';
      const label = `${p.name}${stockLabel} — R$ ${Number(p.price).toFixed(2)}`;
      return [Markup.button.callback(label, `select_product_${p.id}`)];
    });
    buttons.push([Markup.button.callback('◀️ Voltar', 'show_home')]);

    await editOrReply(ctx, '🛒 <b>Nossos Produtos</b>\n\nEscolha um produto abaixo:', {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
    });
  } catch (error) {
    console.error('[showProducts] Erro:', error);
    await editOrReply(ctx, '❌ Erro ao buscar produtos. Tente novamente em instantes.', {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Tentar Novamente', 'show_products')],
        [Markup.button.callback('◀️ Voltar', 'show_home')],
      ]).reply_markup,
    });
  }
}

// ─── Pedidos ─────────────────────────────────────────────────────────────────────────────────────

export async function showOrders(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  try {
    const orders = await apiClient.getOrders(String(userId));

    if (!orders || orders.length === 0) {
      await editOrReply(
        ctx,
        '📦 <b>Meus Pedidos</b>\n\n<i>Você ainda não fez nenhum pedido.</i>\n\nCompre um produto e ele aparecerá aqui!',
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🛒 Ver Produtos', 'show_products')],
            [Markup.button.callback('◀️ Voltar', 'show_home')],
          ]).reply_markup,
        }
      );
      return;
    }

    const statusEmoji: Record<string, string> = {
      DELIVERED: '✅',
      PENDING: '⏳',
      FAILED: '❌',
      PROCESSING: '🔄',
      CANCELLED: '🚫',
    };

    // FIX-ESCAPEHTML-NUMERIC: date e valor são gerados por toLocaleDateString/toFixed
    // — nunca contêm caracteres especiais HTML, escapeHtml() desnecessário.
    const lines = orders.slice(0, 10).map((o: OrderSummary) => {
      const emoji = statusEmoji[o.status] ?? '📦';
      const date = new Date(o.createdAt).toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        timeZone: 'America/Sao_Paulo',
      });
      const valor = o.amount != null ? ` · R$ ${Number(o.amount).toFixed(2)}` : '';
      const metodo =
        o.paymentMethod === 'BALANCE' ? ' · 💰 Saldo'
        : o.paymentMethod === 'MIXED' ? ' · 🔀 Misto'
        : o.paymentMethod === 'PIX' ? ' · 📱 PIX'
        : '';
      return `${emoji} <b>${escapeHtml(o.productName)}</b> — ${date}${valor}${metodo}`;
    });

    await editOrReply(
      ctx,
      `📦 <b>Meus Pedidos</b>\n\n${lines.join('\n')}\n\n<i>Para suporte, entre em contato informando o nome do produto e a data.</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('◀️ Voltar', 'show_home')]]).reply_markup,
      }
    );
  } catch (err) {
    console.error(`[showOrders] Erro para ${userId}:`, err);
    await editOrReply(ctx, '❌ Erro ao buscar seus pedidos. Tente novamente.', {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Tentar Novamente', 'show_orders')],
        [Markup.button.callback('◀️ Voltar', 'show_home')],
      ]).reply_markup,
    });
  }
}

// ─── Ajuda ───────────────────────────────────────────────────────────────────────────────────────

export async function showHelp(ctx: Context): Promise<void> {
  const supportUrl = env.SUPPORT_PHONE
    ? `https://wa.me/${encodeURIComponent(env.SUPPORT_PHONE)}`
    : '#';

  const text =
    `❓ <b>Central de Ajuda</b>\n\n` +
    `<b>Comandos disponíveis:</b>\n` +
    `/start — Tela inicial\n` +
    `/produtos — Ver produtos\n` +
    `/saldo — Ver e adicionar saldo\n` +
    `/meus_pedidos — Histórico de pedidos\n` +
    `/indicar — Programa de indicação\n` +
    `/ajuda — Esta mensagem\n\n` +
    `<b>Como funciona?</b>\n` +
    `1. Escolha um produto\n` +
    `2. Escolha como pagar: saldo, PIX ou os dois\n` +
    `3. Receba seu acesso automaticamente ✅\n\n` +
    `<b>Saldo pré-pago:</b>\n` +
    `Faça um depósito uma vez e use para várias compras.\n\n` +
    `<b>Problemas com pagamento?</b>\n` +
    `Entre em contato informando o ID do pagamento.`;

  const buttons = env.SUPPORT_PHONE
    ? [
        [Markup.button.url('📞 Contatar Suporte', supportUrl)],
        [Markup.button.callback('◀️ Voltar', 'show_home')],
      ]
    : [[Markup.button.callback('◀️ Voltar', 'show_home')]];

  // FIX-SHOWHELP-EDITORRELY: usa editOrReply em vez de reimplementar
  // editMessageText + sendMessage + atualização manual de mainMessageId.
  await editOrReply(ctx, text, {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
  });
}

// ─── Conta bloqueada ───────────────────────────────────────────────────────────────────────────────

export async function showBlockedMessage(ctx: Context): Promise<void> {
  const supportUrl = env.SUPPORT_PHONE
    ? `https://wa.me/${encodeURIComponent(env.SUPPORT_PHONE)}`
    : '#';

  const buttons = env.SUPPORT_PHONE
    ? [
        [Markup.button.url('📞 Falar com Suporte', supportUrl)],
        [Markup.button.callback('💰 Ver Saldo', 'show_balance')],
        [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
        [Markup.button.callback('🎁 Indique e Ganhe', 'show_referral')],
        [Markup.button.callback('❓ Ajuda', 'show_help')],
      ]
    : [
        [Markup.button.callback('💰 Ver Saldo', 'show_balance')],
        [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
        [Markup.button.callback('🎁 Indique e Ganhe', 'show_referral')],
        [Markup.button.callback('❓ Ajuda', 'show_help')],
      ];

  await editOrReply(
    ctx,
    `🚨 <b>Conta Suspensa</b>\n\n` +
      `Sua conta foi <b>suspensa</b> e o acesso a compras e depósitos está restrito.\n\n` +
      `Você ainda pode:\n` +
      `✅ Ver seu saldo\n` +
      `✅ Consultar seus pedidos\n` +
      `✅ Acessar a ajuda\n\n` +
      `Se acredita que isso é um erro, entre em contato com o suporte.`,
    {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
    }
  );
}

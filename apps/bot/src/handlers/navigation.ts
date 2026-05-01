/**
 * Handlers de navegação: home, produtos, pedidos, ajuda e mensagem de conta bloqueada.
 * TODOS os textos usam MarkdownV2 com escapeMd() — sem mistura HTML/Markdown.
 *
 * P2 FIX: padronização total para MarkdownV2.
 */
import { Context, Markup } from 'telegraf';
import { escapeMd } from '../utils/escape';
import { editOrReply } from '../utils/helpers';
import { getSession } from '../services/session';
import { apiClient } from '../services/apiClient';

// ─── Home ────────────────────────────────────────────────────────────────────

export async function showHome(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  const session = await getSession(userId);
  const firstName = escapeMd(ctx.from?.first_name || session.firstName || 'visitante');

  const text =
    `👋 *Olá, ${firstName}\!*\n\n` +
    `Escolha uma opção abaixo para continuar:`;

  await editOrReply(ctx, text, {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('🛒 Ver Produtos', 'show_products')],
      [Markup.button.callback('💰 Meu Saldo', 'show_balance')],
      [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
      [Markup.button.callback('❓ Ajuda', 'show_help')],
    ]).reply_markup,
  });
}

// ─── Produtos ────────────────────────────────────────────────────────────────

export async function showProducts(ctx: Context): Promise<void> {
  try {
    const products = await apiClient.getProducts();

    if (!products || products.length === 0) {
      await editOrReply(ctx, '🔭 *Nenhum produto disponível no momento\.*\n\nVolte em breve\!', {
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu Inicial', 'show_home')]]).reply_markup,
      });
      return;
    }

    const buttons = products.map((p) => {
      const stock = p.stock != null && p.stock <= 0 ? ' \[ESGOTADO\]' : '';
      const label = `${escapeMd(p.name)}${stock} — R$ ${escapeMd(Number(p.price).toFixed(2))}`;
      return [Markup.button.callback(label, `select_product_${p.id}`)];
    });

    buttons.push([Markup.button.callback('◀️ Voltar', 'show_home')]);

    await editOrReply(ctx, '*🛒 Produtos Disponíveis*\n\nEscolha um produto:', {
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
    });
  } catch {
    await editOrReply(ctx, '⚠️ Erro ao carregar produtos\. Tente novamente\!', {
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏠 Menu Inicial', 'show_home')]]).reply_markup,
    });
  }
}

// ─── Pedidos ─────────────────────────────────────────────────────────────────

export async function showOrders(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  try {
    const orders = await apiClient.getOrders(String(userId));

    if (!orders || orders.length === 0) {
      await editOrReply(ctx, '🔭 *Você ainda não tem pedidos\.*\n\nFaça sua primeira compra\!', {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🛒 Ver Produtos', 'show_products')],
          [Markup.button.callback('◀️ Voltar', 'show_home')],
        ]).reply_markup,
      });
      return;
    }

    const lines = orders.slice(0, 10).map((o, i) => {
      const status =
        o.status === 'DELIVERED'
          ? '✅'
          : o.status === 'PENDING'
          ? '⏳'
          : o.status === 'CANCELLED'
          ? '❌'
          : '❓';
      return `${i + 1}\. ${status} *${escapeMd(o.productName)}* — R$ ${escapeMd(Number(o.amount).toFixed(2))}`;
    });

    await editOrReply(
      ctx,
      `*📦 Seus Últimos Pedidos*\n\n${lines.join('\n')}\n\n_Exibindo até 10 pedidos mais recentes\._`,
      {
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🛒 Nova Compra', 'show_products')],
          [Markup.button.callback('◀️ Voltar', 'show_home')],
        ]).reply_markup,
      }
    );
  } catch {
    await editOrReply(ctx, '⚠️ Erro ao carregar pedidos\. Tente novamente\!', {
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('◀️ Voltar', 'show_home')]]).reply_markup,
    });
  }
}

// ─── Ajuda ───────────────────────────────────────────────────────────────────

export async function showHelp(ctx: Context): Promise<void> {
  await editOrReply(
    ctx,
    `*❓ Central de Ajuda*\n\n` +
      `*Como funciona?*\n` +
      `1\. Escolha um produto em 🛒 *Ver Produtos*\n` +
      `2\. Selecione a forma de pagamento \(PIX ou Saldo\)\n` +
      `3\. Pague e receba seu produto automaticamente\n\n` +
      `*Problemas?*\n` +
      `• PIX não aprovado? Aguarde até 2 minutos e verifique novamente\.\n` +
      `• Produto não entregue? Entre em contato com o suporte\.`,
    {
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('◀️ Voltar', 'show_home')]]).reply_markup,
    }
  );
}

// ─── Conta bloqueada ─────────────────────────────────────────────────────────

export async function showBlockedMessage(ctx: Context): Promise<void> {
  await editOrReply(
    ctx,
    `🚫 *Conta Suspensa*\n\n` +
      `Sua conta foi suspensa temporariamente\.\n` +
      `Entre em contato com o suporte para mais informações\.`,
    {
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('❓ Ajuda', 'show_help')]]).reply_markup,
    }
  );
}

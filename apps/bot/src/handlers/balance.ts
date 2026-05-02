/**
 * Handlers de saldo: visualização, depósito via PIX.
 * PADRÃO: parse_mode HTML em todas as mensagens de texto.
 * Captions de replyWithPhoto usam MarkdownV2 (limitação do Telegram).
 *
 * FIX-DEPOSIT-SESSION-ORDER: session.depositPaymentId/depositMessageId só são
 *   persistidos APÓS replyWithPhoto ter sucesso, evitando sessão orphan quando
 *   o Telegram rejeita a mensagem com erro 400.
 * FIX-ESCAPEHTML-NUMERIC: escapeHtml() removido de Number(balance).toFixed(2).
 * FIX-DEPOSIT-STEP-ORDER: session.step='idle' e saveSession movidos para após
 *   createDeposit ter sucesso, consistente com FIX-SESSION-ORDER do projeto.
 * FIX-MDV2-BANG: '!' no literal 'automaticamente! ✅' escapado para MarkdownV2.
 */
import { Context, Markup } from 'telegraf';
import { escapeHtml, escapeMd } from '../utils/escape';
import { editOrReply } from '../utils/helpers';
import { getSession, saveSession } from '../services/session';
import { apiClient } from '../services/apiClient';
import { showBlockedMessage } from './navigation';
import type { WalletTransactionDTO } from '@saas-pix/shared';

export async function showBalance(ctx: Context): Promise<void> {
  const userId = ctx.from!.id;
  try {
    const { balance, transactions } = await apiClient.getBalance(String(userId));

    const txLines = (transactions as WalletTransactionDTO[])
      .slice(0, 5)
      .map((t) => {
        const sinal = t.type === 'DEPOSIT' ? '➕' : '➖';
        return `${sinal} R$ ${Number(t.amount).toFixed(2)} — ${escapeHtml(t.description)}`;
      })
      .join('\n');

    // FIX-ESCAPEHTML-NUMERIC: Number(balance).toFixed(2) é numérico — sem escapeHtml
    const texto =
      `💰 <b>Seu Saldo</b>\n\n` +
      `Disponível: <b>R$ ${Number(balance).toFixed(2)}</b>\n\n` +
      (txLines ? `<b>Últimas transações:</b>\n${txLines}\n\n` : '<i>Nenhuma transação ainda.</i>\n\n') +
      `Use seu saldo para comprar sem precisar fazer PIX toda hora!`;

    const config = await apiClient.getBotConfig(String(userId)).catch(() => ({ isBlocked: false }));
    const buttons = config.isBlocked
      ? [
          [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
          [Markup.button.callback('◀️ Voltar', 'show_home')],
        ]
      : [
          [Markup.button.callback('➕ Adicionar Saldo', 'deposit_balance')],
          [Markup.button.callback('◀️ Voltar', 'show_home')],
        ];

    await editOrReply(ctx, texto, {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard(buttons).reply_markup,
    });
  } catch (err) {
    console.error(`[showBalance] Erro para ${userId}:`, err);
    await editOrReply(ctx, '❌ Erro ao buscar saldo. Tente novamente.', {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('◀️ Voltar', 'show_home')]]).reply_markup,
    });
  }
}

export async function handleDepositAmount(ctx: Context, text: string): Promise<void> {
  const userId = ctx.from!.id;
  const session = await getSession(userId);

  const valor = parseFloat(text.replace(',', '.'));

  if (isNaN(valor) || valor < 1 || valor > 10000) {
    await ctx.reply(
      '❌ Valor inválido. Digite um valor entre R$ 1,00 e R$ 10.000,00.\n\nExemplo: <code>25</code> ou <code>50.00</code>',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const processingMsg = await ctx.reply('⏳ Gerando PIX de depósito, aguarde...', { parse_mode: 'HTML' });

  try {
    const deposit = await apiClient.createDeposit(String(userId), valor, ctx.from?.first_name, ctx.from?.username);

    await ctx.deleteMessage(processingMsg.message_id).catch(() => {});

    const expiresAt = new Date(deposit.expiresAt);
    const expiresStr = expiresAt.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });

    const qrBuffer = Buffer.from(deposit.pixQrCode, 'base64');

    // FIX-DEPOSIT-SESSION-ORDER: envia a foto PRIMEIRO.
    // Se replyWithPhoto falhar, a sessão NÃO fica com depositPaymentId orphan.
    // FIX-MDV2-BANG: '!' escapado como '\\!' no literal MarkdownV2.
    const depositMsg = await ctx.replyWithPhoto(
      { source: qrBuffer },
      {
        caption:
          `💳 *Depósito de Saldo*\n` +
          `Valor: *R$ ${escapeMd(valor.toFixed(2))}*\n` +
          `Válido até: ${escapeMd(expiresStr)}\n` +
          `🪺 ID: \`${escapeMd(deposit.paymentId)}\`\n\n` +
          `📋 *Copia e Cola:*\n\`${escapeMd(deposit.pixQrCodeText)}\`\n\n` +
          `Após o pagamento, o saldo será creditado automaticamente\! ✅`,
        parse_mode: 'MarkdownV2',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Verificar Pagamento', `check_payment_${deposit.paymentId}`)],
          [Markup.button.callback('❌ Cancelar Depósito', `cancel_payment_${deposit.paymentId}`)],
        ]).reply_markup,
      }
    );

    // FIX-DEPOSIT-STEP-ORDER: persiste o estado só após foto enviada com sucesso
    session.step = 'idle';
    session.depositPaymentId = deposit.paymentId;
    session.depositMessageId = depositMsg.message_id;
    session.mainMessageId = depositMsg.message_id;
    await saveSession(userId, session);

    console.info(`[deposit] PIX gerado para ${userId} | valor: ${valor} | id: ${deposit.paymentId}`);
  } catch (err) {
    await ctx.deleteMessage(processingMsg.message_id).catch(() => {});
    console.error(`[deposit] Erro para ${userId}:`, err);

    const errMsg = err instanceof Error ? err.message : '';
    const errStatus = (err as { statusCode?: number }).statusCode ?? 0;

    if (errStatus === 403 || errMsg.toLowerCase().includes('suspensa')) {
      await showBlockedMessage(ctx);
      return;
    }

    await ctx.reply(
      '❌ Erro ao gerar PIX de depósito. Tente novamente.',
      {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('◀️ Voltar', 'show_balance')]]).reply_markup,
      }
    );
  }
}

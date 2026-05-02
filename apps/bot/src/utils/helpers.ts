/**
 * Helpers reutilizáveis para edição/envio de mensagens no Telegram.
 * PADRÃO: parse_mode HTML em todo o projeto — nunca MarkdownV2.
 * O editOrReply NÃO impõe parse_mode padrão; cada caller decide o seu.
 */
import { Context, Markup } from 'telegraf';
import type { ExtraEditMessageText } from 'telegraf/typings/telegram-types';
import { getSession, saveSession, UserSession } from '../services/session';

/**
 * Edita a mensagem principal do usuário (mainMessageId) ou envia nova.
 * parse_mode deve ser passado explicitamente pelo caller (padrão: HTML).
 */
export async function editOrReply(
  ctx: Context,
  text: string,
  extra: ExtraEditMessageText = { parse_mode: 'HTML' }
): Promise<void> {
  const userId = ctx.from!.id;
  const session = await getSession(userId);
  const chatId = ctx.chat?.id ?? userId;

  if (session.mainMessageId) {
    try {
      await ctx.telegram.editMessageText(chatId, session.mainMessageId, undefined, text, extra);
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (
        !msg.includes('message is not modified') &&
        !msg.includes('message to edit not found') &&
        !msg.includes('MESSAGE_ID_INVALID')
      ) {
        console.warn(`[editOrReply] Erro ao editar: ${msg}`);
      }
    }
  }

  const sent = await ctx.telegram.sendMessage(chatId, text, extra);
  session.mainMessageId = sent.message_id;
  await saveSession(userId, session);
}

/**
 * Deleta a mensagem de foto (QR Code) e envia uma mensagem de texto limpa no lugar.
 * Necessário porque o Telegram não permite editar foto → texto.
 */
export async function deletePhotoAndReply(
  ctx: Context,
  session: UserSession,
  userId: number,
  text: string,
  extra: ExtraEditMessageText = { parse_mode: 'HTML' }
): Promise<void> {
  const chatId = ctx.chat?.id ?? userId;

  const photoMsgId = session.depositMessageId ?? session.mainMessageId;
  if (photoMsgId) {
    await ctx.telegram.deleteMessage(chatId, photoMsgId).catch(() => {});
    session.mainMessageId = undefined;
    session.depositMessageId = undefined;
  }

  const sent = await ctx.telegram.sendMessage(chatId, text, extra);
  session.mainMessageId = sent.message_id;
  await saveSession(userId, session);
}

/**
 * Retorna o markup do menu principal (botões inline).
 */
export function homeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🛒 Ver Produtos', 'show_products')],
    [Markup.button.callback('💰 Meu Saldo', 'show_balance')],
    [Markup.button.callback('📦 Meus Pedidos', 'show_orders')],
    [Markup.button.callback('❓ Ajuda', 'show_help')],
  ]);
}

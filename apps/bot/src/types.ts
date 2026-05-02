/**
 * Tipos compartilhados do bot — contexto Telegraf tipado.
 *
 * BotContext é o contexto base usado em todos os handlers.
 * Para handlers de callback (bot.action), use:
 *   NarrowedContext<BotContext, CallbackQuery.DataQuery>
 * Para handlers de comando (bot.command), o Telegraf já narrowa
 *   automaticamente para CommandContext.
 */
import { Context, NarrowedContext } from 'telegraf';
import type { CallbackQuery, Update } from 'telegraf/types';

/** Contexto base do bot — use em funções genéricas como showHome, showBalance etc. */
export type BotContext = Context;

/**
 * Contexto de callback query com data (bot.action).
 * Garante que ctx.callbackQuery.data existe e é string.
 */
export type CallbackCtx = NarrowedContext<BotContext, Update.CallbackQueryUpdate<CallbackQuery.DataQuery>>;

/**
 * Contexto de mensagem de texto (bot.on('text') / bot.command).
 * Garante que ctx.message.text existe.
 */
export type TextCtx = NarrowedContext<BotContext, Update.MessageUpdate>;

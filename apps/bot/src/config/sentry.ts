/**
 * Inicialização do Sentry para monitoramento de erros em produção.
 * P3 FIX: erros em produção agora são capturados e reportados.
 *
 * Chamar initSentry() ANTES de qualquer outro import no index.ts.
 * Em desenvolvimento (sem SENTRY_DSN), é um no-op seguro.
 */
import * as Sentry from '@sentry/node';
import { env } from './env';

export function initSentry(): void {
  if (!env.SENTRY_DSN) {
    console.info('[Sentry] SENTRY_DSN não definido — monitoramento desativado.');
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 0,
    // Não enviar dados de usuários identificáveis além do telegramId
    beforeSend(event) {
      if (event.user) {
        event.user = { id: event.user.id };
      }
      return event;
    },
  });

  console.info(`[Sentry] Monitoramento ativo (env: ${env.NODE_ENV})`);
}

/**
 * Captura uma exceção manualmente, com contexto extra opcional.
 * Seguro de chamar mesmo sem Sentry inicializado.
 */
export function captureError(
  error: unknown,
  context?: Record<string, unknown>
): void {
  if (!env.SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    if (context) scope.setExtras(context);
    Sentry.captureException(error);
  });
}

/**
 * Utilitários de escape de texto para o Telegram.
 * PADrÃO DO PROJETO: parse_mode HTML.
 * escapeHtml() é a função principal — use sempre.
 * escapeMd() mantido apenas para compatibilidade com captions de foto (replyWithPhoto).
 *
 * Ambas as funções aceitam string | number | null | undefined:
 * - null/undefined retornam string vazia
 * - number é convertido com String()
 * Isso evita crashes em runtime quando campos opcionais do Telegram chegam null.
 */

/** Escapa caracteres especiais do HTML para uso com parse_mode HTML */
export function escapeHtml(text: string | number | null | undefined): string {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Escapa caracteres especiais do MarkdownV2 — use APENAS em captions de replyWithPhoto */
export function escapeMd(text: string | number | null | undefined): string {
  if (text == null) return '';
  return String(text).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

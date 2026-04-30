'use client';

import { useState } from 'react';

interface SendResult {
  sent: number;
  failed: number;
}

export default function BroadcastPage() {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    if (!message.trim() || sending) return;
    const confirmed = window.confirm(
      `Confirma o envio desta mensagem para TODOS os usuários ativos?`
    );
    if (!confirmed) return;

    setSending(true);
    setResult(null);
    setError(null);

    try {
      const res = await fetch('/api/admin/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Erro ao enviar broadcast');
      setResult(data.data ?? { sent: data.sent ?? 0, failed: data.failed ?? 0 });
      setMessage('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erro desconhecido');
    } finally {
      setSending(false);
    }
  }

  const charCount = message.length;
  const isEmpty = !message.trim();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Broadcast</h1>
        <p className="text-gray-500 text-sm mt-1">
          Envie uma mensagem para todos os usuários ativos do bot
        </p>
      </div>

      {/* Feedback de resultado */}
      {result && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 flex items-center gap-3">
          <span className="text-lg">✅</span>
          <span>
            Broadcast enviado com sucesso —{' '}
            <strong>{result.sent} entregues</strong>
            {result.failed > 0 && (
              <span className="text-yellow-700">, {result.failed} falharam (usuários que bloquearam o bot)</span>
            )}
          </span>
          <button
            onClick={() => setResult(null)}
            className="ml-auto text-green-600 hover:text-green-800 text-lg leading-none"
          >
            ×
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center gap-3">
          <span className="text-lg">❌</span>
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-auto text-red-500 hover:text-red-700 text-lg leading-none"
          >
            ×
          </button>
        </div>
      )}

      {/* Formulário */}
      <div className="card space-y-5">
        {/* Dicas de formatação */}
        <div className="flex flex-wrap gap-2">
          {[
            { label: '*negrito*', insert: '*texto*' },
            { label: '_itálico_', insert: '_texto_' },
            { label: '`código`', insert: '`texto`' },
            { label: '```bloco```', insert: '```\ntexto\n```' },
          ].map((tip) => (
            <button
              key={tip.label}
              onClick={() => setMessage((m) => m + tip.insert)}
              className="px-2 py-1 rounded-lg bg-gray-100 text-gray-600 text-xs font-mono hover:bg-gray-200 transition-colors"
            >
              {tip.label}
            </button>
          ))}
          <span className="text-xs text-gray-400 self-center ml-1">— formatação Markdown do Telegram</span>
        </div>

        {/* Textarea */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Mensagem
          </label>
          <textarea
            className="input w-full min-h-[180px] resize-y font-mono text-sm leading-relaxed"
            placeholder="Digite sua mensagem...&#10;&#10;Exemplo:&#10;🎉 *Promoção especial!*&#10;Use o código PROMO10 e ganhe 10% de desconto hoje."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={sending}
          />
          <div className="flex justify-between mt-1">
            <span className={`text-xs ${
              charCount > 4096 ? 'text-red-500 font-medium' : 'text-gray-400'
            }`}>
              {charCount}/4096 caracteres
            </span>
            {!isEmpty && (
              <button
                onClick={() => setPreview(!preview)}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium"
              >
                {preview ? '⬆ Ocultar prévia' : '⬇ Ver prévia'}
              </button>
            )}
          </div>
        </div>

        {/* Preview */}
        {preview && !isEmpty && (
          <div>
            <p className="text-xs font-medium text-gray-500 mb-1.5">Prévia (texto puro):</p>
            <div className="p-3 bg-gray-50 rounded-xl border border-gray-200 text-sm text-gray-800 whitespace-pre-wrap font-mono">
              {message}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between pt-3 border-t border-gray-100">
          <p className="text-xs text-gray-400">
            ⚠️ A mensagem será enviada para <strong className="text-gray-600">todos os usuários ativos</strong>.
            Essa ação não pode ser desfeita.
          </p>
          <button
            onClick={handleSend}
            disabled={isEmpty || sending || charCount > 4096}
            className="btn-primary ml-4 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending ? (
              <span className="flex items-center gap-2">
                <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white inline-block" />
                Enviando...
              </span>
            ) : (
              '📢 Enviar broadcast'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

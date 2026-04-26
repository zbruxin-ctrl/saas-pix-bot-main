// ALTERAÇÕES: exibe stockItem.content (conteúdo entregue), deliveryMedias,
// cancelledAt, isBlocked do usuário, e medias do pedido
'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getPayment } from '@/lib/api';
import StatusBadge from '@/components/admin/StatusBadge';
import { formatCurrency, formatDate } from '@/lib/utils';

type DeliveryLog = {
  id?: string;
  status?: string;
  attempt?: number;
  message?: string;
  error?: string;
  createdAt?: string;
};

type DeliveryMedia = {
  id?: string;
  url?: string;
  mediaType?: string;
  caption?: string;
  sortOrder?: number;
};

type WebhookEvent = {
  eventType?: string;
  externalId?: string;
  status?: string;
  createdAt?: string;
};

type Payment = {
  id: string;
  mercadoPagoId?: string;
  status: string;
  amount: number;
  createdAt: string;
  approvedAt?: string;
  cancelledAt?: string;
  pixExpiresAt?: string;
  telegramUser?: {
    firstName?: string;
    username?: string;
    telegramId?: string;
    isBlocked?: boolean;
  };
  product?: {
    name?: string;
    deliveryType?: string;
  };
  order?: {
    id?: string;
    status?: string;
    deliveredAt?: string;
    deliveryLogs?: DeliveryLog[];
    deliveryMedias?: DeliveryMedia[];
  };
  webhookEvents?: WebhookEvent[];
  stockItem?: {
    content?: string;
    status?: string;
  } | null;
};

export default function PaymentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [payment, setPayment] = useState<Payment | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getPayment(id)
      .then(setPayment as any)
      .catch(() => router.push('/admin/payments'))
      .finally(() => setLoading(false));
  }, [id, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (!payment) return null;

  const user = payment.telegramUser || {};
  const product = payment.product || {};
  const order = payment.order || null;
  const deliveryLogs = order?.deliveryLogs || [];
  const deliveryMedias = order?.deliveryMedias || [];
  const webhookEvents = payment.webhookEvents || [];
  const stockItem = payment.stockItem;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <button
          onClick={() => router.back()}
          className="text-gray-500 hover:text-gray-700 text-sm"
        >
          ← Voltar
        </button>
        <h1 className="text-2xl font-bold text-gray-900">Detalhes do Pagamento</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pagamento */}
        <div className="card space-y-4">
          <h2 className="font-semibold text-gray-900 text-lg">Pagamento</h2>
          <InfoRow label="ID Interno" value={payment.id} mono />
          <InfoRow label="ID Mercado Pago" value={payment.mercadoPagoId || '—'} mono />
          <InfoRow label="Status" value={<StatusBadge status={payment.status} />} />
          <InfoRow label="Valor" value={formatCurrency(payment.amount)} bold />
          <InfoRow label="Criado em" value={formatDate(payment.createdAt)} />
          {payment.approvedAt && (
            <InfoRow label="Aprovado em" value={formatDate(payment.approvedAt)} />
          )}
          {payment.cancelledAt && (
            <InfoRow label="Cancelado em" value={formatDate(payment.cancelledAt)} />
          )}
          {payment.pixExpiresAt && (
            <InfoRow label="PIX expira em" value={formatDate(payment.pixExpiresAt)} />
          )}
        </div>

        {/* Usuário Telegram */}
        <div className="card space-y-4">
          <h2 className="font-semibold text-gray-900 text-lg">Usuário Telegram</h2>
          <InfoRow label="Nome" value={user.firstName || '—'} />
          <InfoRow label="Username" value={user.username ? `@${user.username}` : '—'} />
          <InfoRow label="Telegram ID" value={user.telegramId || '—'} mono />
          {user.isBlocked && (
            <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 font-medium">
              ⚠️ Este usuário está bloqueado no bot
            </div>
          )}
        </div>

        {/* Produto */}
        <div className="card space-y-4">
          <h2 className="font-semibold text-gray-900 text-lg">Produto</h2>
          <InfoRow label="Nome" value={product.name || '—'} bold />
          <InfoRow label="Tipo de Entrega" value={product.deliveryType || '—'} />
          <InfoRow label="Status do Pedido" value={order?.status || 'Sem pedido'} />
          {order?.deliveredAt && (
            <InfoRow label="Entregue em" value={formatDate(order.deliveredAt)} />
          )}
        </div>

        {/* Conteúdo entregue */}
        {stockItem?.content && (
          <div className="card space-y-3">
            <h2 className="font-semibold text-gray-900 text-lg">Conteúdo Entregue</h2>
            <p className="text-xs text-gray-400">
              Use para suporte. Não compartilhe publicamente.
            </p>
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <pre className="whitespace-pre-wrap break-all font-mono text-sm text-gray-800">
                {stockItem.content}
              </pre>
            </div>
            <div className="text-xs text-gray-500">
              Status do item:{' '}
              <span className="font-medium text-gray-700">{stockItem.status || '—'}</span>
            </div>
          </div>
        )}

        {/* Logs de entrega */}
        {deliveryLogs.length > 0 && (
          <div className="card space-y-3">
            <h2 className="font-semibold text-gray-900 text-lg">Logs de Entrega</h2>
            {deliveryLogs.map((log, i) => (
              <div
                key={log.id || i}
                className={`rounded-lg p-3 text-sm ${
                  log.status === 'SUCCESS'
                    ? 'bg-green-50 text-green-800'
                    : log.status === 'FAILED'
                    ? 'bg-red-50 text-red-800'
                    : 'bg-yellow-50 text-yellow-800'
                }`}
              >
                <div className="font-medium">
                  Tentativa {log.attempt} — {log.status}
                </div>
                {log.message && <div className="mt-1 text-xs">{log.message}</div>}
                {log.error && <div className="mt-1 text-xs text-red-700">{log.error}</div>}
                <div className="text-xs opacity-60 mt-1">
                  {log.createdAt ? formatDate(log.createdAt) : ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Mídias da entrega */}
      {deliveryMedias.length > 0 && (
        <div className="card">
          <h2 className="font-semibold text-gray-900 text-lg mb-4">Mídias Entregues</h2>
          <div className="flex flex-wrap gap-4">
            {deliveryMedias.map((m, i) => (
              <div key={m.id || i} className="flex flex-col gap-1">
                {m.mediaType === 'IMAGE' ? (
                  <img
                    src={m.url}
                    alt={m.caption || `Mídia ${i + 1}`}
                    className="rounded-lg max-h-40 object-cover border border-gray-200"
                    loading="lazy"
                  />
                ) : (
                  <a
                    href={m.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-600 underline break-all"
                  >
                    {m.mediaType} — {m.caption || m.url}
                  </a>
                )}
                {m.caption && (
                  <span className="text-xs text-gray-500">{m.caption}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Eventos Webhook */}
      {webhookEvents.length > 0 && (
        <div className="card">
          <h2 className="font-semibold text-gray-900 text-lg mb-4">Eventos Webhook</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2 font-semibold text-gray-600">Tipo</th>
                  <th className="text-left py-2 font-semibold text-gray-600">ID Externo</th>
                  <th className="text-left py-2 font-semibold text-gray-600">Status</th>
                  <th className="text-left py-2 font-semibold text-gray-600">Recebido em</th>
                </tr>
              </thead>
              <tbody>
                {webhookEvents.map((e, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    <td className="py-2">{e.eventType}</td>
                    <td className="py-2 font-mono">{e.externalId}</td>
                    <td className="py-2">{e.status}</td>
                    <td className="py-2">{e.createdAt ? formatDate(e.createdAt) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono,
  bold,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  bold?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-sm text-gray-500 flex-shrink-0">{label}</span>
      <span
        className={`text-sm text-right ${mono ? 'font-mono text-xs' : ''} ${
          bold ? 'font-semibold' : ''
        } text-gray-900`}
      >
        {value}
      </span>
    </div>
  );
}

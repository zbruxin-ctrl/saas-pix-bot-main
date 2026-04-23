'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getPayment } from '@/lib/api';
import StatusBadge from '@/components/admin/StatusBadge';
import { formatCurrency, formatDate } from '@/lib/utils';

export default function PaymentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [payment, setPayment] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getPayment(id)
      .then(setPayment)
      .catch(() => router.push('/admin/payments'))
      .finally(() => setLoading(false));
  }, [id, router]);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" />
    </div>
  );

  if (!payment) return null;

  const user = payment.telegramUser as Record<string, string>;
  const product = payment.product as Record<string, unknown>;
  const order = payment.order as Record<string, unknown> | null;
  const deliveryLogs = order?.deliveryLogs as Array<Record<string, unknown>> || [];
  const webhookEvents = payment.webhookEvents as Array<Record<string, unknown>> || [];

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <button onClick={() => router.back()} className="text-gray-500 hover:text-gray-700 text-sm">
          ← Voltar
        </button>
        <h1 className="text-2xl font-bold text-gray-900">Detalhes do Pagamento</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Informações do pagamento */}
        <div className="card space-y-4">
          <h2 className="font-semibold text-gray-900 text-lg">Pagamento</h2>
          <InfoRow label="ID Interno" value={payment.id as string} mono />
          <InfoRow label="ID Mercado Pago" value={(payment.mercadoPagoId as string) || '—'} mono />
          <InfoRow label="Status" value={<StatusBadge status={payment.status as string} />} />
          <InfoRow label="Valor" value={formatCurrency(payment.amount as number)} bold />
          <InfoRow label="Criado em" value={formatDate(payment.createdAt as string)} />
          {payment.approvedAt && (
            <InfoRow label="Aprovado em" value={formatDate(payment.approvedAt as string)} />
          )}
          {payment.pixExpiresAt && (
            <InfoRow label="PIX expira em" value={formatDate(payment.pixExpiresAt as string)} />
          )}
        </div>

        {/* Informações do usuário */}
        <div className="card space-y-4">
          <h2 className="font-semibold text-gray-900 text-lg">Usuário Telegram</h2>
          <InfoRow label="Nome" value={user.firstName || '—'} />
          <InfoRow label="Username" value={user.username ? `@${user.username}` : '—'} />
          <InfoRow label="Telegram ID" value={user.telegramId} mono />
        </div>

        {/* Produto */}
        <div className="card space-y-4">
          <h2 className="font-semibold text-gray-900 text-lg">Produto</h2>
          <InfoRow label="Nome" value={product.name as string} bold />
          <InfoRow label="Tipo de Entrega" value={product.deliveryType as string} />
          <InfoRow label="Status do Pedido" value={order ? (order.status as string) : 'Sem pedido'} />
          {order?.deliveredAt && (
            <InfoRow label="Entregue em" value={formatDate(order.deliveredAt as string)} />
          )}
        </div>

        {/* Logs de entrega */}
        {deliveryLogs.length > 0 && (
          <div className="card space-y-3">
            <h2 className="font-semibold text-gray-900 text-lg">Logs de Entrega</h2>
            {deliveryLogs.map((log, i) => (
              <div key={i} className={`rounded-lg p-3 text-sm ${
                log.status === 'SUCCESS' ? 'bg-green-50 text-green-800' :
                log.status === 'FAILED' ? 'bg-red-50 text-red-800' :
                'bg-yellow-50 text-yellow-800'
              }`}>
                <div className="font-medium">Tentativa {log.attempt as number} — {log.status as string}</div>
                {log.message && <div className="mt-1 text-xs">{log.message as string}</div>}
                {log.error && <div className="mt-1 text-xs text-red-700">{log.error as string}</div>}
                <div className="text-xs opacity-60 mt-1">{formatDate(log.createdAt as string)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Webhook events */}
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
                    <td className="py-2">{e.eventType as string}</td>
                    <td className="py-2 font-mono">{e.externalId as string}</td>
                    <td className="py-2">{e.status as string}</td>
                    <td className="py-2">{formatDate(e.createdAt as string)}</td>
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

function InfoRow({ label, value, mono, bold }: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  bold?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-sm text-gray-500 flex-shrink-0">{label}</span>
      <span className={`text-sm text-right ${mono ? 'font-mono text-xs' : ''} ${bold ? 'font-semibold' : ''} text-gray-900`}>
        {value}
      </span>
    </div>
  );
}

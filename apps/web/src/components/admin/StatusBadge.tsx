// Componente de badge de status do pagamento
export default function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    APPROVED: 'badge-approved',
    PENDING: 'badge-pending',
    REJECTED: 'badge-rejected',
    CANCELLED: 'badge-rejected',
    EXPIRED: 'badge-expired',
    REFUNDED: 'badge-expired',
  };

  const labels: Record<string, string> = {
    APPROVED: '✅ Aprovado',
    PENDING: '⏳ Pendente',
    REJECTED: '❌ Rejeitado',
    CANCELLED: '🚫 Cancelado',
    EXPIRED: '⌛ Expirado',
    REFUNDED: '↩️ Reembolsado',
  };

  return (
    <span className={map[status] || 'badge-expired'}>
      {labels[status] || status}
    </span>
  );
}

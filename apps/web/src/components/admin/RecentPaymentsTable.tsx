import StatusBadge from './StatusBadge';
import { formatCurrency, formatDate } from '@/lib/utils';
import type { RecentPaymentItem } from '@saas-pix/shared';

export default function RecentPaymentsTable({ payments }: { payments: RecentPaymentItem[] }) {
  if (payments.length === 0) {
    return (
      <div className="text-center py-8 text-gray-400 text-sm">
        Nenhum pagamento aprovado ainda
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100">
            <th className="text-left py-2 font-semibold text-gray-500">Usuário</th>
            <th className="text-left py-2 font-semibold text-gray-500">Produto</th>
            <th className="text-left py-2 font-semibold text-gray-500">Valor</th>
            <th className="text-left py-2 font-semibold text-gray-500">Data</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => (
            <tr key={p.id} className="border-b border-gray-50 hover:bg-gray-50">
              <td className="py-2.5 font-medium text-gray-900">{p.userName}</td>
              <td className="py-2.5 text-gray-600">{p.productName}</td>
              <td className="py-2.5 font-semibold text-green-700">{formatCurrency(p.amount)}</td>
              <td className="py-2.5 text-gray-400 text-xs">{formatDate(p.approvedAt ?? '')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

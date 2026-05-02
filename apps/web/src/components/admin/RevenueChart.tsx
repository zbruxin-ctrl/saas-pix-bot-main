'use client';

// Gráfico de receita dos últimos N dias — feito com SVG nativo, sem biblioteca externa
// Compatível com Next.js (Vercel) sem nenhuma dependência adicional

interface ChartPoint {
  date: string;
  revenue: number;
}

interface RevenueChartProps {
  data: ChartPoint[];
}

function formatDate(dateStr: string): string {
  const [, month, day] = dateStr.split('-');
  return `${day}/${month}`;
}

function formatCurrency(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export default function RevenueChart({ data }: RevenueChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Receita — últimos 30 dias</h2>
        <div className="h-40 flex items-center justify-center text-gray-400 text-sm">
          Nenhuma venda no período
        </div>
      </div>
    );
  }

  const maxRevenue = Math.max(...data.map((d) => d.revenue), 1);
  const totalPeriod = data.reduce((s, d) => s + d.revenue, 0);
  const daysWithSales = data.filter((d) => d.revenue > 0).length;

  const width = 800;
  const height = 160;
  const padLeft = 8;
  const padRight = 8;
  const padTop = 12;
  const padBottom = 28;

  const chartWidth = width - padLeft - padRight;
  const chartHeight = height - padTop - padBottom;

  const points = data.map((d, i) => {
    const x = padLeft + (i / (data.length - 1)) * chartWidth;
    const y = padTop + chartHeight - (d.revenue / maxRevenue) * chartHeight;
    return { x, y, ...d };
  });

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');

  const areaD =
    pathD +
    ` L ${points[points.length - 1].x.toFixed(1)} ${(padTop + chartHeight).toFixed(1)}` +
    ` L ${points[0].x.toFixed(1)} ${(padTop + chartHeight).toFixed(1)} Z`;

  // Mostra labels a cada 5 dias para não poluir
  const labelIndices = data
    .map((_, i) => i)
    .filter((i) => i === 0 || i === data.length - 1 || i % 5 === 0);

  return (
    <div className="card">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
        <h2 className="text-lg font-semibold text-gray-900">Receita — últimos 30 dias</h2>
        <div className="flex gap-4 text-sm text-gray-500">
          <span>
            Total: <strong className="text-gray-900">{formatCurrency(totalPeriod)}</strong>
          </span>
          <span>
            Dias com vendas: <strong className="text-gray-900">{daysWithSales}</strong>
          </span>
        </div>
      </div>

      <div className="w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="w-full"
          style={{ height: 160 }}
        >
          <defs>
            <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Linha de base */}
          <line
            x1={padLeft} y1={padTop + chartHeight}
            x2={width - padRight} y2={padTop + chartHeight}
            stroke="#e5e7eb" strokeWidth="1"
          />

          {/* Área preenchida */}
          <path d={areaD} fill="url(#revenueGrad)" />

          {/* Linha principal */}
          <path d={pathD} fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

          {/* Pontos com receita > 0 */}
          {points.filter((p) => p.revenue > 0).map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="3" fill="#3b82f6" />
          ))}

          {/* Labels do eixo X */}
          {labelIndices.map((i) => (
            <text
              key={i}
              x={points[i].x}
              y={height - 6}
              textAnchor="middle"
              fontSize="10"
              fill="#9ca3af"
            >
              {formatDate(data[i].date)}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}

import clsx from 'clsx';

interface StatsCardProps {
  title: string;
  value: string;
  subtitle?: string;
  icon: string;
  color: 'green' | 'blue' | 'purple' | 'yellow' | 'red';
}

const colorMap = {
  green: 'bg-green-50 text-green-600',
  blue: 'bg-blue-50 text-blue-600',
  purple: 'bg-purple-50 text-purple-600',
  yellow: 'bg-yellow-50 text-yellow-600',
  red: 'bg-red-50 text-red-600',
};

export default function StatsCard({ title, value, subtitle, icon, color }: StatsCardProps) {
  return (
    <div className="card">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm font-medium text-gray-500">{title}</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
          {subtitle && <p className="text-xs text-gray-400 mt-1">{subtitle}</p>}
        </div>
        <div className={clsx('w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0', colorMap[color])}>
          {icon}
        </div>
      </div>
    </div>
  );
}

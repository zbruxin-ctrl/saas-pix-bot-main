'use client';

import { useEffect, useState } from 'react';
import { getMe } from '@/lib/api';

interface AdminUser {
  name: string;
  email: string;
  role: string;
}

export default function Header() {
  const [admin, setAdmin] = useState<AdminUser | null>(null);

  useEffect(() => {
    getMe().then(setAdmin).catch(() => {});
  }, []);

  return (
    <header className="h-16 bg-white border-b border-gray-100 flex items-center justify-between px-6 flex-shrink-0">
      <div className="text-sm text-gray-500">
        {new Date().toLocaleDateString('pt-BR', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })}
      </div>

      {admin && (
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-sm font-medium text-gray-900">{admin.name}</div>
            <div className="text-xs text-gray-400">{admin.role}</div>
          </div>
          <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 font-semibold text-sm">
            {admin.name[0].toUpperCase()}
          </div>
        </div>
      )}
    </header>
  );
}

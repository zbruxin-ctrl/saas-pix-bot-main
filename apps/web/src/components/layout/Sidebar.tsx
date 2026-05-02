'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import clsx from 'clsx';

const navItems = [
  { href: '/admin',            label: 'Dashboard',      icon: '📊', exact: true  },
  { href: '/admin/payments',   label: 'Pagamentos',     icon: '💳', exact: false },
  { href: '/admin/products',   label: 'Produtos',       icon: '📦', exact: false },
  { href: '/admin/users',      label: 'Usuários',       icon: '👥', exact: false },
  { href: '/admin/referrals',  label: 'Indicações',     icon: '🎁', exact: false },
  { href: '/admin/coupons',    label: 'Cupons',         icon: '🏷️', exact: false },
  { href: '/admin/broadcast',  label: 'Broadcast',      icon: '📢', exact: false },
  { href: '/admin/settings',   label: 'Configurações',  icon: '⚙️', exact: false },
];

export default function Sidebar() {
  const pathname  = usePathname();
  const router    = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch (_) {
      // ignora erros de rede — cookie já foi removido
    } finally {
      // Força reload completo para limpar estado do Next.js e do middleware
      window.location.replace('/login');
    }
  }

  return (
    <aside className="w-64 bg-white border-r border-gray-100 flex flex-col flex-shrink-0">
      {/* Logo */}
      <div className="h-16 flex items-center px-6 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-sm">
            💳
          </div>
          <div>
            <div className="font-bold text-gray-900 text-sm">PIX Bot</div>
            <div className="text-xs text-gray-400">Painel Admin</div>
          </div>
        </div>
      </div>

      {/* Navegação */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
          const isActive = item.exact
            ? pathname === item.href
            : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors',
                isActive
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              )}
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Rodapé — logout */}
      <div className="px-3 py-4 border-t border-gray-100">
        <button
          onClick={handleLogout}
          disabled={loggingOut}
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors w-full disabled:opacity-50"
        >
          <span>🚪</span>
          {loggingOut ? 'Saindo...' : 'Sair'}
        </button>
      </div>
    </aside>
  );
}

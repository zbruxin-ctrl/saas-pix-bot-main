const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Garante que o output file tracing inclua pacotes do monorepo (packages/shared)
  experimental: {
    outputFileTracingRoot: path.join(__dirname, '../../'),
  },

  webpack(config) {
    // Garante que o alias @ resolva corretamente mesmo quando o CWD
    // nao e apps/web (ex: build na raiz do monorepo via Vercel)
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': path.join(__dirname, 'src'),
    };
    return config;
  },

  async redirects() {
    return [
      {
        source: '/',
        destination: '/admin',
        permanent: false,
      },
    ];
  },

  async rewrites() {
    // API_URL é a variável server-side (sem prefixo NEXT_PUBLIC_)
    // Fallback para NEXT_PUBLIC_API_URL em ambientes que só têm ela
    const apiUrl =
      process.env.API_URL ||
      process.env.NEXT_PUBLIC_API_URL ||
      'http://localhost:3001';

    return [
      {
        // Redireciona /api/admin/:path* diretamente para o backend no Railway
        // Isso evita que o Next.js sirva 404 HTML quando a página chama /api/admin/settings
        source: '/api/admin/:path*',
        destination: `${apiUrl}/api/admin/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;

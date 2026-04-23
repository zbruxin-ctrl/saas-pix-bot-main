// Middleware do Next.js — redireciona para /login se não houver cookie de auth
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Rotas que exigem autenticação
  const isAdminRoute = pathname.startsWith('/admin');

  // Cookie definido pela API no login (httpOnly, então não acessível aqui)
  // Usamos um cookie de "presença" não-httpOnly apenas para sinalizar ao middleware
  // O cookie real auth_token é validado pelo backend
  const hasSession = request.cookies.has('auth_presence');

  if (isAdminRoute && !hasSession) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('from', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Redireciona /login para /admin se já estiver logado
  if (pathname === '/login' && hasSession) {
    return NextResponse.redirect(new URL('/admin', request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Aplica apenas às rotas relevantes (ignora _next, assets, api)
  matcher: ['/admin/:path*', '/login'],
};

import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

async function handler(request: NextRequest, { params }: { params: { path: string[] } }) {
  const path = params.path.join('/');
  const search = request.nextUrl.search;
  const url = `${API_URL}/api/${path}${search}`;

  // ✅ Repassa TODOS os cookies do browser para a API
  const cookieHeader = request.headers.get('cookie') || '';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cookie': cookieHeader,
  };

  // Repassa Authorization header se existir
  const auth = request.headers.get('authorization');
  if (auth) headers['Authorization'] = auth;

  const init: RequestInit = {
    method: request.method,
    headers,
    credentials: 'include',
  };

  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = await request.text();
  }

  const apiRes = await fetch(url, init);
  const data = await apiRes.text();

  const response = new NextResponse(data, {
    status: apiRes.status,
    headers: {
      'Content-Type': apiRes.headers.get('Content-Type') || 'application/json',
    },
  });

  // ✅ Repassa Set-Cookie da API de volta para o browser
  const setCookie = apiRes.headers.get('set-cookie');
  if (setCookie) {
    response.headers.set('set-cookie', setCookie);
  }

  return response;
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;

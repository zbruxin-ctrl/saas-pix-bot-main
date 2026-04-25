import { NextRequest, NextResponse } from 'next/server';

const API_URL = (process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '');
const ADMIN_ORIGIN = process.env.NEXT_PUBLIC_APP_URL || 'https://saas-pix-bot.vercel.app'; // ← nova linha

async function handler(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  if (!API_URL) {
    console.error('[PROXY] API_URL não configurada!');
    return NextResponse.json({ error: 'API_URL não configurada no servidor' }, { status: 500 });
  }

  const path = params.path.join('/');
  const search = request.nextUrl.search;
  const url = `${API_URL}/api/${path}${search}`;

  console.log('[PROXY]', request.method, url);

  try {
    const cookieHeader = request.headers.get('cookie') || '';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
      'Origin': ADMIN_ORIGIN, // ← linha adicionada
    };

    const auth = request.headers.get('authorization');
    if (auth) headers['Authorization'] = auth;

    const init: RequestInit = {
      method: request.method,
      headers,
    };

    if (!['GET', 'HEAD'].includes(request.method)) {
      init.body = await request.text();
    }

    const apiRes = await fetch(url, init);
    const data = await apiRes.text();

    console.log('[PROXY] status:', apiRes.status, url);

    const response = new NextResponse(data, {
      status: apiRes.status,
      headers: {
        'Content-Type': apiRes.headers.get('Content-Type') || 'application/json',
      },
    });

    const setCookie = apiRes.headers.get('set-cookie');
    if (setCookie) {
      response.headers.set('set-cookie', setCookie);
    }

    return response;
  } catch (err) {
    console.error('[PROXY] erro ao chamar API:', err);
    return NextResponse.json(
      { error: 'Falha ao conectar com a API', detail: String(err) },
      { status: 502 }
    );
  }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;

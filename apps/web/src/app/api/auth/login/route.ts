import { NextRequest, NextResponse } from 'next/server';

// API_URL é server-side only (sem NEXT_PUBLIC_). Configure no Vercel como:
// API_URL = https://api-production-a596.up.railway.app
const API_URL =
  process.env.API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  'https://api-production-a596.up.railway.app';

export async function POST(request: NextRequest) {
  const body = await request.json();

  const origin =
    request.headers.get('origin') ||
    request.headers.get('host') ||
    'https://saas-pix-bot.vercel.app';

  let apiRes: Response;

  try {
    apiRes = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin.startsWith('http') ? origin : `https://${origin}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[login] Falha ao conectar na API:', API_URL, err);
    return NextResponse.json(
      { success: false, error: 'Não foi possível conectar ao servidor. Tente novamente.' },
      { status: 502 }
    );
  }

  const data = await apiRes.json();

  if (!apiRes.ok) {
    return NextResponse.json(data, { status: apiRes.status });
  }

  const response = NextResponse.json(data);
  const isProduction = process.env.NODE_ENV === 'production';

  const setCookieHeaders = apiRes.headers.getSetCookie
    ? apiRes.headers.getSetCookie()
    : [apiRes.headers.get('set-cookie') ?? ''];

  let authToken: string | null = null;

  for (const header of setCookieHeaders) {
    if (!header) continue;
    if (header.includes('auth_token=')) {
      authToken = header.split(';')[0].split('=').slice(1).join('=');
    }
  }

  if (authToken) {
    response.cookies.set('auth_token', authToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60,
      path: '/',
    });
  }

  response.cookies.set('auth_presence', '1', {
    httpOnly: false,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60,
    path: '/',
  });

  return response;
}

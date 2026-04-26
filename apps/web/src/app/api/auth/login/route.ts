import { NextRequest, NextResponse } from 'next/server';

const API_URL =
  process.env.API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  'https://api-production-a596.up.railway.app';

/**
 * O Express usa signed cookies: o valor no Set-Cookie vem como
 * s:eyJhbGci....HMAC_DO_COOKIE
 * Precisamos guardar apenas o JWT puro (3 partes: header.payload.sig)
 */
function extractJwtFromSignedCookie(raw: string): string {
  // decodifica %3A → :
  const decoded = decodeURIComponent(raw);
  const value = decoded.startsWith('s:') ? decoded.slice(2) : decoded;
  // JWT tem exatamente 3 partes. Signed cookie adiciona uma 4ª parte (HMAC do cookie).
  const parts = value.split('.');
  if (parts.length >= 4) {
    return parts.slice(0, 3).join('.');
  }
  return value;
}

export async function POST(request: NextRequest) {
  const body = await request.json();

  let apiRes: Response;
  try {
    apiRes = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[login] Falha ao conectar na API:', API_URL, err);
    return NextResponse.json(
      { success: false, error: 'N\u00e3o foi poss\u00edvel conectar ao servidor.' },
      { status: 502 }
    );
  }

  const data = await apiRes.json();

  if (!apiRes.ok) {
    return NextResponse.json(data, { status: apiRes.status });
  }

  const response = NextResponse.json(data);
  const isProduction = process.env.NODE_ENV === 'production';

  // pega todos os Set-Cookie da resposta da API
  const setCookieHeaders = typeof apiRes.headers.getSetCookie === 'function'
    ? apiRes.headers.getSetCookie()
    : [apiRes.headers.get('set-cookie') ?? ''];

  console.log('[login] set-cookie headers da API:', setCookieHeaders.map(h => h.slice(0, 80)));

  let authToken: string | null = null;

  for (const header of setCookieHeaders) {
    if (!header || !header.includes('auth_token=')) continue;
    // pega apenas o valor (antes do primeiro ";")
    const rawValue = header.split(';')[0].split('=').slice(1).join('=');
    authToken = extractJwtFromSignedCookie(rawValue);
    console.log('[login] rawValue:', rawValue.slice(0, 60));
    console.log('[login] authToken extraido:', authToken.slice(0, 60));
  }

  if (authToken) {
    response.cookies.set('auth_token', authToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60,
      path: '/',
    });
  } else {
    console.warn('[login] auth_token NAO encontrado nos headers da API!');
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

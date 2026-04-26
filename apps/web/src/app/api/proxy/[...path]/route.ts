import { NextRequest, NextResponse } from 'next/server';

const API_URL =
  process.env.API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  'https://api-production-a596.up.railway.app';

async function proxyRequest(request: NextRequest, method: string): Promise<NextResponse> {
  const url = request.nextUrl;
  const segments = url.pathname.replace('/api/proxy/', '');
  const targetUrl = `${API_URL}/api/${segments}${url.search}`;

  // auth_token ja e salvo como JWT puro pelo route de login
  const authToken = request.cookies.get('auth_token')?.value ?? null;

  console.log('[proxy] authToken:', authToken ? authToken.slice(0, 50) + '...' : 'NENHUM');
  console.log('[proxy] target:', targetUrl);

  const headers: Record<string, string> = {};

  const ct = request.headers.get('content-type');
  if (ct && !ct.includes('multipart/form-data')) {
    headers['Content-Type'] = ct;
  }

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  let body: BodyInit | undefined;
  if (!['GET', 'HEAD', 'DELETE'].includes(method)) {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      body = await request.formData();
    } else {
      const text = await request.text();
      body = text || undefined;
    }
  }

  try {
    const apiRes = await fetch(targetUrl, { method, headers, body });
    const responseBody = await apiRes.text();

    console.log('[proxy] api status:', apiRes.status);
    if (apiRes.status >= 400) {
      console.log('[proxy] api response:', responseBody.slice(0, 200));
    }

    const response = new NextResponse(responseBody, {
      status: apiRes.status,
      statusText: apiRes.statusText,
    });

    const responseCt = apiRes.headers.get('content-type');
    if (responseCt) response.headers.set('content-type', responseCt);

    return response;
  } catch (error) {
    console.error('[proxy] fetch error:', targetUrl, error);
    return NextResponse.json(
      { success: false, error: 'Erro de conex\u00e3o com a API' },
      { status: 503 }
    );
  }
}

export async function GET(request: NextRequest) { return proxyRequest(request, 'GET'); }
export async function POST(request: NextRequest) { return proxyRequest(request, 'POST'); }
export async function PUT(request: NextRequest) { return proxyRequest(request, 'PUT'); }
export async function PATCH(request: NextRequest) { return proxyRequest(request, 'PATCH'); }
export async function DELETE(request: NextRequest) { return proxyRequest(request, 'DELETE'); }

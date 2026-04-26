import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;

function sign(params: Record<string, string>, apiSecret: string) {
  const toSign = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  return crypto
    .createHash('sha1')
    .update(toSign + apiSecret)
    .digest('hex');
}

export async function POST(req: NextRequest) {
  try {
    if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
      return NextResponse.json(
        { error: 'Cloudinary não configurado no ambiente.' },
        { status: 500 }
      );
    }

    const formData = await req.formData();
    const file = formData.get('file');
    const mediaType = String(formData.get('mediaType') || 'IMAGE');

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'Arquivo inválido ou não enviado.' },
        { status: 400 }
      );
    }

    const maxSizeByType: Record<string, number> = {
      IMAGE: 10 * 1024 * 1024,
      VIDEO: 50 * 1024 * 1024,
      FILE: 20 * 1024 * 1024,
    };

    const maxSize = maxSizeByType[mediaType] ?? 10 * 1024 * 1024;
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: `Arquivo muito grande para ${mediaType}.` },
        { status: 400 }
      );
    }

    const timestamp = String(Math.floor(Date.now() / 1000));
    const folder = 'saas-pix-bot/products';

    let resourceType = 'image';
    if (mediaType === 'VIDEO') resourceType = 'video';
    if (mediaType === 'FILE') resourceType = 'raw';

    const paramsToSign = { timestamp, folder };
    const signature = sign(paramsToSign, API_SECRET);

    const cloudinaryForm = new FormData();
    cloudinaryForm.append('file', file);
    cloudinaryForm.append('api_key', API_KEY);
    cloudinaryForm.append('timestamp', timestamp);
    cloudinaryForm.append('folder', folder);
    cloudinaryForm.append('signature', signature);

    const uploadRes = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/${resourceType}/upload`,
      {
        method: 'POST',
        body: cloudinaryForm,
      }
    );

    const data = await uploadRes.json();

    if (!uploadRes.ok) {
      return NextResponse.json(
        { error: data?.error?.message || 'Erro ao fazer upload no Cloudinary.' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      url: data.secure_url,
      publicId: data.public_id,
      resourceType: data.resource_type,
      originalFilename: data.original_filename,
      bytes: data.bytes,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Falha interna no upload.' },
      { status: 500 }
    );
  }
}

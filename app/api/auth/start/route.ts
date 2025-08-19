import { NextResponse } from 'next/server';
import { buildAuthorizeUrl, validShopDomain } from '@/lib/shopify-auth';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const shop = (searchParams.get('shop') || '').toLowerCase();
  if (!validShopDomain(shop)) {
    return new NextResponse('<h1>Parametro shop mancante o non valido</h1>', { status: 400, headers: { 'Content-Type': 'text/html' }});
  }
  const apiKey = process.env.SHOPIFY_API_KEY!;
  const scopes = process.env.OAUTH_SCOPES!;
  const appUrl = process.env.APP_URL!;
  const url = buildAuthorizeUrl(shop, scopes, appUrl, apiKey);

  const state = url.searchParams.get('state')!;
  const res = NextResponse.redirect(url.toString());
  res.cookies.set('xmas_state', state, { httpOnly: true, sameSite: 'none', secure: true, path: '/' });
  return res;
}

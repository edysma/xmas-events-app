import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { sql } from '@/lib/db';
import { verifyHmac, validShopDomain } from '@/lib/shopify-auth';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const shop = url.searchParams.get('shop') || '';
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const cookieState = cookies().get('xmas_state')?.value || '';

  if (!validShopDomain(shop) || !code || !state) {
    return new NextResponse('<h1>Parametri mancanti</h1>', { status: 400, headers: { 'Content-Type': 'text/html' }});
  }
  if (!verifyHmac(process.env.SHOPIFY_API_SECRET!, url.searchParams)) {
    return new NextResponse('<h1>HMAC non valido</h1>', { status: 400, headers: { 'Content-Type': 'text/html' }});
  }
  if (cookieState !== state) {
    return new NextResponse('<h1>State non valido</h1>', { status: 400, headers: { 'Content-Type': 'text/html' }});
  }

  // scambia code -> access_token
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Accept':'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY!,
      client_secret: process.env.SHOPIFY_API_SECRET!,
      code
    })
  });
  if (!res.ok) {
    return new NextResponse(`<h1>Errore token ${res.status}</h1>`, { status: 500, headers: { 'Content-Type': 'text/html' }});
  }
  const data = await res.json(); // { access_token, scope }
  await sql`CREATE TABLE IF NOT EXISTS shops (
    shop text PRIMARY KEY, access_token text NOT NULL, scope text, installed_at timestamptz DEFAULT now()
  );`;
  await sql`INSERT INTO shops (shop, access_token, scope) VALUES (${shop}, ${data.access_token}, ${data.scope || ''})
            ON CONFLICT (shop) DO UPDATE SET access_token = EXCLUDED.access_token, scope = EXCLUDED.scope, installed_at = now();`;

  const html = `
  <html><body style="font-family:system-ui;padding:2rem">
    <h1>Installazione completata ✅</h1>
    <p>App installata su <strong>${shop}</strong>.</p>
    <p>Puoi chiudere questa scheda e tornare all’Admin.</p>
    <p style="margin-top:1rem"><a href="/api/health">Health</a></p>
  </body></html>`;
  const ok = new NextResponse(html, { headers: { 'Content-Type': 'text/html' }});
  ok.cookies.set('xmas_state','', { path:'/', maxAge:0 });
  return ok;
}

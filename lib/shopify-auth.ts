import crypto from 'crypto';

export function randomString(len=16){ return crypto.randomBytes(len).toString('hex'); }

export function buildAuthorizeUrl(shop: string, scopes: string, appUrl: string, apiKey: string){
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id', apiKey);
  url.searchParams.set('scope', scopes);
  url.searchParams.set('redirect_uri', `${appUrl}/api/auth/callback`);
  url.searchParams.set('state', randomString(16));
  return url;
}

export function verifyHmac(secret: string, query: URLSearchParams){
  const qp: Record<string, string> = {};
  for (const [k,v] of query) qp[k]=v;
  const given = qp.hmac || '';
  delete qp.hmac; delete qp.signature;
  const msg = Object.keys(qp).sort().map(k => `${k}=${qp[k]}`).join('&');
  const digest = crypto.createHmac('sha256', secret).update(msg).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(digest,'utf8'), Buffer.from(given,'utf8')); }
  catch { return false; }
}

export function validShopDomain(shop?: string){
  return !!shop && /^[a-z0-9-]+\.myshopify\.com$/.test(shop);
}

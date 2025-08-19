export const runtime = 'nodejs';

import { sql } from '@/lib/db';
import { shopifyAdminGraphQL as gql } from '@/lib/shopify-admin';

function normalizePricing(input?: string){
  let j: any; try { j = input ? JSON.parse(input) : null; } catch { j = null; }
  const currency = (j?.currency || 'EUR').toUpperCase();

  function normSide(side: any){
    const mode: 'single'|'tiered' = (side?.mode === 'tiered') ? 'tiered' : 'single';
    if (mode === 'single') {
      const p = Number(side?.single?.price ?? side?.price ?? 0);
      return { mode:'single', prices: { 'Normale': isNaN(p) ? 0 : p } };
    }
    const src = side?.tiered || {};
    const map: Record<string, number> = {};
    ['Intero','Bambino','Handicap'].forEach(k => {
      const v = Number(src[k]); if (!isNaN(v)) map[k] = v;
    });
    if (Object.keys(map).length === 0) return { mode:'single', prices:{ 'Normale': 0 } };
    return { mode:'tiered', prices: map };
  }

  return {
    version: 1,
    currency,
    weekday: normSide(j?.weekday),
    holiday: normSide(j?.holiday)
  };
}

async function getShopAndToken(){
  const { rows } = await sql`SELECT shop, access_token FROM shops LIMIT 1`;
  if (!rows.length) throw new Error('No installed shop found');
  const { shop, access_token: token } = rows[0] as { shop: string; access_token: string };
  return { shop, token };
}

async function readProductPricing(shop: string, token: string, handle: string){
  // Admin GraphQL: cerchiamo per handle via query
  const data = await gql(shop, token, `
    query($q: String!) {
      products(first: 1, query: $q) {
        edges { node {
          metafield(namespace:"custom", key:"ticket_pricing"){ value }
        } }
      }
    }
  `, { q: `handle:${handle}` });
  const edge = data?.products?.edges?.[0];
  return edge?.node?.metafield?.value as string | undefined;
}

async function readCollectionPricing(shop: string, token: string, handle: string){
  const data = await gql(shop, token, `
    query($q: String!) {
      collections(first: 1, query: $q) {
        edges { node {
          metafield(namespace:"custom", key:"ticket_pricing"){ value }
        } }
      }
    }
  `, { q: `handle:${handle}` });
  const edge = data?.collections?.edges?.[0];
  return edge?.node?.metafield?.value as string | undefined;
}

async function readShopPricing(shop: string, token: string){
  const data = await gql(shop, token, `
    query {
      shop { metafield(namespace:"custom", key:"ticket_pricing"){ value } }
    }
  `);
  return data?.shop?.metafield?.value as string | undefined;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const productHandle    = (url.searchParams.get('product') || '').trim();
    const collectionHandle = (url.searchParams.get('collection') || '').trim();

    const { shop, token } = await getShopAndToken();

    let raw: string | undefined;
    let source: 'product' | 'collection' | 'shop' | 'default' = 'default';

    if (productHandle) {
      raw = await readProductPricing(shop, token, productHandle);
      if (raw) source = 'product';
    }
    if (!raw && collectionHandle) {
      raw = await readCollectionPricing(shop, token, collectionHandle);
      if (raw) source = 'collection';
    }
    if (!raw) {
      raw = await readShopPricing(shop, token);
      if (raw) source = 'shop';
    }

    const cfg = normalizePricing(raw);

    return new Response(JSON.stringify({ ...cfg, source }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600'
      }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 500 });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

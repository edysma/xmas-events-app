// app/api/admin-ping/route.ts
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// CORS aperto per test (puoi rimuoverlo dopo)
function withCORS(res: NextResponse) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "*");
  return res;
}
export async function OPTIONS() {
  return withCORS(new NextResponse(null, { status: 204 }));
}

export async function GET(_req: NextRequest) {
  try {
    const domain = process.env.SHOPIFY_STORE_DOMAIN;
    const token = process.env.SHOPIFY_ADMIN_API_TOKEN;
    const apiVer = process.env.SHOPIFY_ADMIN_API_VERSION || "2025-07";

    if (!domain) throw new Error("Missing env SHOPIFY_STORE_DOMAIN");
    if (!token) throw new Error("Missing env SHOPIFY_ADMIN_API_TOKEN");

    const resp = await fetch(`https://${domain}/admin/api/${apiVer}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({
        query: `query { shop { name myshopifyDomain } }`,
        variables: {},
      }),
      cache: "no-store",
    });

    const text = await resp.text();
    if (!resp.ok) {
      return withCORS(
        NextResponse.json(
          { ok: false, status: resp.status, error: "admin_api_error", body: text.slice(0, 5000) },
          { status: 500 }
        )
      );
    }
    const json = JSON.parse(text);
    return withCORS(
      NextResponse.json(
        { ok: true, admin_api_version: apiVer, shop: json?.data?.shop ?? null },
        { status: 200 }
      )
    );
  } catch (err: any) {
    return withCORS(
      NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 })
    );
  }
}

// app/api/_sf-health/route.ts
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const handle = url.searchParams.get("collection") || undefined;

    const domain = process.env.SHOPIFY_STORE_DOMAIN || "";
    const token  = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || "";

    const info = {
      domain,
      token_head: token ? token.slice(0, 4) : "",
      token_len: token?.length || 0,
    };

    if (!domain || !token) {
      return NextResponse.json({ ok: false, info, error: "Missing envs" }, { status: 200 });
    }

    const endpoint = `https://${domain}/api/2024-07/graphql.json`;

    // 1) shop { name }
    const shopRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": token,
      },
      body: JSON.stringify({ query: "{ shop { name } }" }),
      cache: "no-store",
    });

    const shopStatus = shopRes.status;
    const shopJson = await shopRes.json().catch(() => ({}));

    // 2) collection(handle) (se passato)
    let coll: any = null;
    if (handle) {
      const collRes = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": token,
        },
        body: JSON.stringify({
          query:
            "query($h:String!){ collection(handle:$h){ title products(first:5){ edges{ node{ id title } } } } }",
          variables: { h: handle },
        }),
        cache: "no-store",
      });
      coll = {
        status: collRes.status,
        json: await collRes.json().catch(() => ({})),
      };
    }

    return NextResponse.json(
      { ok: true, info, shopStatus, shopJson, collection: coll },
      { status: 200 }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || e) },
      { status: 200 }
    );
  }
}

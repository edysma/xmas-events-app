// app/api/admin/debug-variant-components/route.ts
import { NextRequest, NextResponse } from "next/server";
import { adminFetchGQL } from "@/lib/shopify-admin";

export async function GET(req: NextRequest) {
  try {
    const secret = req.headers.get("x-admin-secret");
    if (!secret || secret !== process.env.ADMIN_SECRET) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const variantId = searchParams.get("variantId");
    if (!variantId) {
      return NextResponse.json(
        { ok: false, error: "missing_param", detail: "Passa ?variantId=<gid://shopify/ProductVariant/...>" },
        { status: 400 }
      );
    }

    const Q = /* GraphQL */ `
      query DebugVariantComponents($id: ID!) {
        productVariant(id: $id) {
          id
          title
          productVariantComponents(first: 50) {
            nodes {
              id
              productVariant { id title }
              quantity
            }
          }
        }
      }
    `;

    const data = await adminFetchGQL<{
      productVariant: {
        id: string;
        title: string;
        productVariantComponents?: { nodes: { id: string; quantity?: number | null; productVariant: { id: string; title: string } }[] };
      } | null
    }>(Q, { id: variantId });

    const pv = data.productVariant;
    if (!pv) {
      return NextResponse.json({ ok: false, error: "not_found", detail: "Variant non trovata" }, { status: 404 });
    }

    const comps = (pv.productVariantComponents?.nodes || []).map(n => ({
      relId: n.id,
      childVariantId: n.productVariant.id,
      childTitle: n.productVariant.title,
      qty: n.quantity ?? null
    }));

    return NextResponse.json({
      ok: true,
      variantId: pv.id,
      variantTitle: pv.title,
      components: comps
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: "internal_error", detail: String(err?.message || err) }, { status: 500 });
  }
}

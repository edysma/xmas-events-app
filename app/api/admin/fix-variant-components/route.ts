// app/api/admin/fix-variant-components/route.ts
import { NextRequest, NextResponse } from "next/server";
import { adminFetchGQL } from "@/lib/shopify-admin";

const M_VARIANT_REL_BULK_UPDATE = /* GraphQL */ `
  mutation BundleFix($input: [ProductVariantRelationshipUpdateInput!]!) {
    productVariantRelationshipBulkUpdate(input: $input) {
      parentProductVariants {
        id
        productVariantComponents(first: 25) {
          nodes {
            id
            quantity
            productVariant { id displayName }
          }
        }
      }
      userErrors { code field message }
    }
  }
`;

export async function POST(req: NextRequest) {
  try {
    // sicurezza header
    const secret = req.headers.get("x-admin-secret");
    if (!secret || secret !== process.env.ADMIN_SECRET) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => null) as
      | { parentVariantId: string; childVariantId: string; qty: number }
      | null;

    if (!body?.parentVariantId || !body?.childVariantId || typeof body?.qty !== "number") {
      return NextResponse.json({ ok: false, error: "invalid_input" }, { status: 400 });
    }
    if (body.qty < 1) {
      return NextResponse.json({ ok: false, error: "qty_must_be_positive" }, { status: 400 });
    }

    // 1) rimuove TUTTE le relazioni esistenti verso quel child
    // 2) ricrea UNA relazione con la qty desiderata
    const input = [
      {
        parentProductVariantId: body.parentVariantId,
        productVariantRelationshipsToRemove: [body.childVariantId],
        productVariantRelationshipsToCreate: [{ id: body.childVariantId, quantity: body.qty }],
      },
    ];

    const res = await adminFetchGQL<{
      productVariantRelationshipBulkUpdate: {
        parentProductVariants?: {
          id: string;
          productVariantComponents: { nodes: { id: string; quantity: number; productVariant: { id: string } }[] };
        }[];
        userErrors: { code?: string; field?: string[]; message: string }[];
      };
    }>(M_VARIANT_REL_BULK_UPDATE, { input });

    const errs = res.productVariantRelationshipBulkUpdate?.userErrors || [];
    if (errs.length) {
      return NextResponse.json(
        { ok: false, error: "shopify_error", detail: errs.map(e => e.message).join(" | ") },
        { status: 500 }
      );
    }

    const parent = res.productVariantRelationshipBulkUpdate?.parentProductVariants?.[0];
    return NextResponse.json({
      ok: true,
      parentVariantId: body.parentVariantId,
      components: parent?.productVariantComponents?.nodes?.map(n => ({
        relId: n.id,
        childVariantId: n.productVariant.id,
        qty: n.quantity,
      })) ?? [],
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "internal_error", detail: String(err?.message || err) },
      { status: 500 }
    );
  }
}

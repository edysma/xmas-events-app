// app/api/admin/dedupe-upcoming/route.ts
import { NextResponse } from "next/server";
import { adminFetchGQL } from "@/lib/shopify-admin";

const Q_LIST_BUNDLE_VARIANTS = /* GraphQL */ `
  query List($cursor: String) {
    products(first: 50, after: $cursor, query: "tag:Bundle status:ACTIVE") {
      edges {
        cursor
        node {
          id
          variants(first: 50) {
            edges {
              node {
                id
                metafields(identifiers: [
                  { namespace: "sinflora", key: "seat_unit" },
                  { namespace: "sinflora", key: "seats_per_ticket" }
                ]) { key value }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

const M_REL_BULK = /* GraphQL */ `
  mutation PVRRelBulkUpdate($input: [ProductVariantRelationshipUpdateInput!]!) {
    productVariantRelationshipBulkUpdate(input: $input) {
      userErrors { field message }
    }
  }
`;

async function listAllBundleVariants() {
  const variants: { id: string; seat: string; qty: number }[] = [];
  let cursor: string | null = null;
  while (true) {
    const data = await adminFetchGQL(Q_LIST_BUNDLE_VARIANTS, { cursor });
    const edges = data?.products?.edges || [];
    for (const e of edges) {
      const vEdges = e?.node?.variants?.edges || [];
      for (const ve of vEdges) {
        const v = ve.node;
        const mfs = v?.metafields || [];
        const seat = mfs.find((m:any)=>m?.key==="seat_unit")?.value;
        const qtyStr = mfs.find((m:any)=>m?.key==="seats_per_ticket")?.value;
        const qty = Number.parseInt(qtyStr ?? "1", 10) || 1;
        if (seat) variants.push({ id: v.id, seat, qty });
      }
    }
    const hasNext = data?.products?.pageInfo?.hasNextPage;
    cursor = hasNext ? edges[edges.length-1]?.cursor : null;
    if (!cursor) break;
  }
  return variants;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret") || req.headers.get("x-admin-secret") || "";
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ ok:false, error:"Unauthorized" }, { status: 401 });
  }
  const dryRun = /^(1|true)$/i.test(url.searchParams.get("dryRun") || "");

  const variants = await listAllBundleVariants();
  const inputs = variants.map(v => ({
    parentProductVariantId: v.id,
    productVariantRelationshipsToRemove: [v.seat],
    productVariantRelationshipsToCreate: [{ id: v.seat, quantity: v.qty }],
  }));

  if (dryRun) {
    return NextResponse.json({ ok:true, dryRun:true, variantsFound: inputs.length });
  }

  // procedi a batch per essere gentile con le API
  let updated = 0;
  for (let i = 0; i < inputs.length; i += 20) {
    const slice = inputs.slice(i, i + 20);
    const res = await adminFetchGQL(M_REL_BULK, { input: slice });
    const errs = res?.productVariantRelationshipBulkUpdate?.userErrors || [];
    if (errs.length) {
      const msg = errs.map((e:any)=>e.message).join(" | ");
      return NextResponse.json({ ok:false, error: msg, at: i }, { status: 500 });
    }
    updated += slice.length;
  }

  return NextResponse.json({ ok:true, updated });
}

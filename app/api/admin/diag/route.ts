// app/api/admin/diag/route.ts
import { NextResponse } from "next/server";
import { adminFetchGQL } from "@/lib/shopify-admin";

const Q = /* GraphQL */ `
  query {
    products(first: 1) {
      edges { node { id title } }
    }
  }
`;

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret") || req.headers.get("x-admin-secret") || "";
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ ok:false, error:"Unauthorized" }, { status: 401 });
  }

  const envOk = {
    SHOP_DOMAIN: Boolean(process.env.SHOP_DOMAIN),
    ADMIN_ACCESS_TOKEN: Boolean(process.env.ADMIN_ACCESS_TOKEN),
  };

  try {
    const res = await adminFetchGQL<any>(Q, {});
    const prod = res?.products?.edges?.[0]?.node ?? null;
    return NextResponse.json({ ok:true, envOk, sampleProduct: prod });
  } catch (err: any) {
    return NextResponse.json({ ok:false, envOk, error: String(err?.message || err) }, { status: 500 });
  }
}

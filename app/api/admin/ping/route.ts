// app/api/admin/ping/route.ts
import { NextRequest, NextResponse } from "next/server";
import { adminFetchGQL } from "@/lib/shopify-admin";

export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-admin-secret");
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const q = /* GraphQL */ `
      query PingProducts {
        products(first: 1) {
          edges { node { id } }
        }
      }
    `;
    const data = await adminFetchGQL<{ products: { edges: { node: { id: string } }[] } }>(q);
    const count = data.products?.edges?.length ?? 0;
    return NextResponse.json({ ok: true, count }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "shopify_error", detail: String(err?.message || err) },
      { status: 500 }
    );
  }
}

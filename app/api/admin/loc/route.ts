// app/api/admin/loc/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getDefaultLocationId } from "@/lib/shopify-admin";

export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-admin-secret");
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const locationId = await getDefaultLocationId();
    return NextResponse.json({ ok: true, locationId }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "shopify_error", detail: String(err?.message || err) },
      { status: 500 }
    );
  }
}

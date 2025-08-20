// app/api/admin/fix-variant-components/route.ts
import { NextRequest, NextResponse } from "next/server";
import { upsertBundleComponents } from "@/lib/bundles";

export async function POST(req: NextRequest) {
  try {
    const secret = req.headers.get("x-admin-secret");
    if (!secret || secret !== process.env.ADMIN_SECRET) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const body = await req.json().catch(() => null);
    if (!body || !body.parentVariantId || !body.childVariantId || typeof body.qty !== "number") {
      return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
    }

    await upsertBundleComponents({
      parentVariantId: body.parentVariantId,
      childVariantId: body.childVariantId,
      qty: body.qty,
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: "internal_error", detail: String(err?.message || err) }, { status: 500 });
  }
}

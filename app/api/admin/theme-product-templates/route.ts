// app/api/admin/theme-product-templates/route.ts
import { NextRequest, NextResponse } from "next/server";
import { listThemeProductTemplates } from "@/lib/shopify-admin";

export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-admin-secret");
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const { themeId, templateKeys } = await listThemeProductTemplates();
    return NextResponse.json({ ok: true, themeId, templateKeys }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "shopify_error", detail: String(err?.message || err) },
      { status: 500 }
    );
  }
}

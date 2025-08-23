// app/api/admin/ping/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

// CORS aperto (richiesto per header custom da browser)
function withCORS(res: NextResponse) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Secret, Authorization");
  res.headers.append("Vary", "Origin");
  return res;
}
export function OPTIONS() {
  return withCORS(new NextResponse(null, { status: 204 }));
}

function isAuthorized(req: NextRequest) {
  const header =
    req.headers.get("x-admin-secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return !!ADMIN_SECRET && header === ADMIN_SECRET;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return withCORS(NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }));
  }
  return withCORS(
    NextResponse.json({
      ok: true,
      service: "admin-ping",
      now: new Date().toISOString(),
      shopDomain: process.env.SHOP_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN || "",
      node: process.version,
    })
  );
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return withCORS(NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }));
  }
  const body = await req.json().catch(() => ({}));
  return withCORS(NextResponse.json({ ok: true, service: "admin-ping", echo: body || null }));
}

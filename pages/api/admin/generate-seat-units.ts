// PAGES ROUTER version (Next.js /pages). Create two files:
// 1) pages/api/admin/generate-seat-units.ts
// 2) pages/api/admin/generate-bundles.ts
// Both are protected by ADMIN_SECRET and accept JSON via POST.

// ============================
// pages/api/admin/generate-seat-units.ts
// ============================
import type { NextApiRequest, NextApiResponse } from "next";

type GenerateSeatUnitsBody = {
  // Esempio: ["2025-12-06", "2025-12-07"] (ISO YYYY-MM-DD)
  dates: string[];
  // Esempio: ["11:00", "12:00", "15:00"] (24h HH:MM)
  times: string[];
  // Nome base del prodotto (verrà usato per creare le Seat Unit)
  productTitleBase: string; // es. "Sinflora Xmas — Seat Unit"
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const header = req.headers["x-admin-secret"]; // header lower-cased
  const secret = Array.isArray(header) ? header[0] : header;
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  let body: GenerateSeatUnitsBody;
  try {
    body = req.body as GenerateSeatUnitsBody;
  } catch {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }

  const { dates, times, productTitleBase } = body || {} as GenerateSeatUnitsBody;
  if (!Array.isArray(dates) || !Array.isArray(times) || !productTitleBase) {
    return res.status(400).json({ ok: false, error: "missing_or_invalid_fields" });
  }

  // TODO: qui andrà la logica reale di creazione prodotti "Seat Unit" via Admin API
  // Per ora rispondiamo con un riepilogo di cosa creeremmo.
  const plan = [] as { date: string; time: string; title: string }[];
  for (const d of dates) {
    for (const t of times) {
      plan.push({ date: d, time: t, title: `${productTitleBase} — ${d} ${t}` });
    }
  }

  return res.status(200).json({ ok: true, count: plan.length, preview: plan.slice(0, 10) });
}

// ============================
// pages/api/admin/generate-bundles.ts
// ============================
import type { NextApiRequest, NextApiResponse } from "next";

type GenerateBundlesBody = {
  // Seat Unit (productId, variantId) per ciascuna combinazione data/orario
  // In seguito le ricaveremo automaticamente; per ora accettiamo input mock o id già noti.
  items: Array<{
    date: string; // YYYY-MM-DD
    time: string; // HH:MM
    seatUnitProductId?: number;
    seatUnitVariantId?: number;
  }>;
  bundleTitleBase: string; // es. "Sinflora Xmas — Bundle"
};

export default async function handlerBundles(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const header = req.headers["x-admin-secret"]; // header lower-cased
  const secret = Array.isArray(header) ? header[0] : header;
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  let body: GenerateBundlesBody;
  try {
    body = req.body as GenerateBundlesBody;
  } catch {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }

  const { items, bundleTitleBase } = body || {} as GenerateBundlesBody;
  if (!Array.isArray(items) || !bundleTitleBase) {
    return res.status(400).json({ ok: false, error: "missing_or_invalid_fields" });
  }

  // TODO: chiamare Shopify Admin API per creare/aggiornare prodotti Bundle (con Shopify Bundles)
  // Per ora restituiamo un piano riassuntivo.
  const plan = items.map((i, idx) => ({
    idx,
    date: i.date,
    time: i.time,
    title: `${bundleTitleBase} — ${i.date} ${i.time}`,
    seatUnitProductId: i.seatUnitProductId ?? null,
    seatUnitVariantId: i.seatUnitVariantId ?? null,
  }));

  return res.status(200).json({ ok: true, count: plan.length, preview: plan.slice(0, 10) });
}

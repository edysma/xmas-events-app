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

  let body: GenerateBundlesBody;
  try {
    body = req.body as GenerateBundlesBody;
  } catch {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }

  const { items, bundleTitleBase } = (body || {}) as GenerateBundlesBody;
  if (!Array.isArray(items) || !bundleTitleBase) {
    return res.status(400).json({ ok: false, error: "missing_or_invalid_fields" });
  }

  // Anteprima: elenco bundle che creeremmo
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

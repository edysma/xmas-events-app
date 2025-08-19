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

  const { dates, times, productTitleBase } = (body || {}) as GenerateSeatUnitsBody;
  if (!Array.isArray(dates) || !Array.isArray(times) || !productTitleBase) {
    return res.status(400).json({ ok: false, error: "missing_or_invalid_fields" });
  }

  // Anteprima: combinazioni data/orario che creeremmo
  const plan: { date: string; time: string; title: string }[] = [];
  for (const d of dates) {
    for (const t of times) {
      plan.push({ date: d, time: t, title: `${productTitleBase} — ${d} ${t}` });
    }
  }

  return res.status(200).json({ ok: true, count: plan.length, preview: plan.slice(0, 10) });
}

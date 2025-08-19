import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  // Leggi il segreto dall'header
  const header = req.headers["x-admin-secret"];
  const secret = Array.isArray(header) ? header[0] : header;

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  return res.status(200).json({
    ok: true,
    shop: process.env.SHOPIFY_STORE_DOMAIN,
  });
}

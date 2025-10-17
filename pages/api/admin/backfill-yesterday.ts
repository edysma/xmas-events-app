// pages/api/admin/backfill-yesterday.ts
import type { NextApiRequest, NextApiResponse } from 'next';

function ymd(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const adminSecret = process.env.ADMIN_SECRET || '';
    const provided = (req.query.secret as string) || (req.headers['x-admin-secret'] as string);
    if (!adminSecret || provided !== adminSecret) {
      return res.status(401).json({ ok: false, error: 'Unauthorized (secret mancante o errato)' });
    }

    // Ora corrente in fuso orario Europe/Rome
    const nowRome = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
    const yRome = new Date(nowRome);
    yRome.setDate(yRome.getDate() - 1);
    const day = ymd(yRome);

    // Reindirizza all’endpoint di backfill con since=until=ieri
    const qs = new URLSearchParams({
      since: day,
      until: day,
      secret: provided,
    }).toString();

    // 302 verso l'endpoint già esistente
    res.setHeader('Location', `/api/admin/orders-backfill-to-sheets?${qs}`);
    return res.status(302).end();
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'Unknown error' });
  }
}

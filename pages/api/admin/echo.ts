// pages/api/admin/echo.ts
import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const pick = (o: any, keys: string[]) =>
    Object.fromEntries(keys.map(k => [k, o[k]]).filter(([_, v]) => v !== undefined));

  res.status(200).json({
    ok: true,
    method: req.method,
    url: req.url,
    query: req.query,
    headers: pick(req.headers, [
      'host',
      'x-forwarded-proto',
      'x-vercel-deployment-url',
      'user-agent'
    ]),
  });
}

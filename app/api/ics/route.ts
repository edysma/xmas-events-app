export const runtime = 'nodejs';

import crypto from 'crypto';

function fmtICSDate(dt: Date){
  // ritorna YYYYMMDDTHHMMSS (ora "locale", senza Z)
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    dt.getFullYear().toString() +
    pad(dt.getMonth()+1) +
    pad(dt.getDate()) +
    'T' +
    pad(dt.getHours()) +
    pad(dt.getMinutes()) +
    pad(dt.getSeconds())
  );
}

export async function GET(req: Request){
  const url = new URL(req.url);

  // Parametri (tutti opzionali tranne title/date/time)
  const title = url.searchParams.get('title') || 'Evento';
  const date  = url.searchParams.get('date')  || '';   // es. 2025-12-06
  const time  = url.searchParams.get('time')  || '';   // es. 11:00
  const dur   = parseInt(url.searchParams.get('duration') || '60', 10); // minuti
  const loc   = url.searchParams.get('location') || '';
  const desc  = url.searchParams.get('desc') || '';
  const uid   = (url.searchParams.get('uid') || crypto.randomBytes(8).toString('hex')) + '@sinflora';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return new Response('Bad Request: use date=YYYY-MM-DD&time=HH:MM', { status: 400 });
  }

  // Costruisco date "naive" locali (senza timezone)
  const [Y,M,D] = date.split('-').map(Number);
  const [h,m]   = time.split(':').map(Number);
  const start   = new Date(Y, M-1, D, h, m, 0);
  const end     = new Date(start.getTime() + dur*60*1000);

  const now = new Date();

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sinflora//Tickets//IT',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${fmtICSDate(now)}`,
    `DTSTART:${fmtICSDate(start)}`,
    `DTEND:${fmtICSDate(end)}`,
    `SUMMARY:${title.replace(/\n/g, ' ')}`,
    loc ? `LOCATION:${loc.replace(/\n/g,' ')}` : '',
    desc ? `DESCRIPTION:${desc.replace(/\n/g,' ')}` : '',
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');

  return new Response(lines, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="evento.ics"`
    }
  });
}

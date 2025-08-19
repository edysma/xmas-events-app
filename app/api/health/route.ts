export const runtime = 'nodejs';

export async function GET() {
  return new Response(JSON.stringify({ ok: true, service: 'xmas-events', ts: Date.now() }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

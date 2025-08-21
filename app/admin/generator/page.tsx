// app/admin/generator/page.tsx
'use client';

import React from 'react';

export default function Page() {
  const [secret, setSecret] = React.useState('');
  const [result, setResult] = React.useState<string>('');
  const [loading, setLoading] = React.useState(false);

  async function handlePing() {
    setLoading(true);
    setResult('');
    try {
      const res = await fetch('/api/admin-ping', {
        method: 'GET',
        headers: {
          // Non obbligatoria per /api/admin-ping, ma lasciamo lo schema
          'x-admin-secret': secret || ''
        },
      });
      const text = await res.text();
      setResult(text);
    } catch (err: any) {
      setResult(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial' }}>
      <h1>Generatore Biglietti (Preview)</h1>
      <p>Mini-pannello di test per le API admin.</p>

      <div style={{ marginTop: 24, display: 'grid', gap: 12, maxWidth: 640 }}>
        <label>
          <div>Admin Secret (x-admin-secret) — opzionale per questo ping</div>
          <input
            type="password"
            placeholder="incolla qui il segreto"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            style={{ width: '100%', padding: 8 }}
          />
        </label>

        <button onClick={handlePing} disabled={loading} style={{ padding: '8px 12px' }}>
          {loading ? 'Pinging…' : 'Ping Admin API'}
        </button>

        <div>
          <div>Risultato:</div>
          <pre style={{ background: '#111', color: '#0f0', padding: 12, whiteSpace: 'pre-wrap' }}>
            {result || '(nessun output ancora)'}
          </pre>
        </div>
      </div>
    </main>
  );
}

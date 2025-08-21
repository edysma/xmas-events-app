'use client';

import React from 'react';

export default function Page() {
  const [secret, setSecret] = React.useState('');
  const [result, setResult] = React.useState<string>('');
  const [loading, setLoading] = React.useState(false);

  async function run(path: string, opts?: RequestInit) {
    setLoading(true);
    setResult('');
    try {
      const res = await fetch(path, {
        method: 'GET',
        headers: {
          'x-admin-secret': secret || '',
          ...(opts?.headers || {}),
        },
        ...opts,
      });
      const text = await res.text();
      setResult(text);
    } catch (err: any) {
      setResult(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }

  async function handlePing() {
    await run('/api/admin-ping'); // non richiede il secret, ma lo inviamo comunque
  }

  async function handleHolidays() {
    await run('/api/admin/holidays'); // richiede il secret
  }

  // 🔹 NUOVO: locationId
  async function handleLoc() {
    await run('/api/admin/loc'); // richiede il secret
  }

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial' }}>
      <h1>Generatore Biglietti (Preview)</h1>
      <p>Mini-pannello di test per le API admin.</p>

      <div style={{ marginTop: 24, display: 'grid', gap: 12, maxWidth: 640 }}>
        <label>
          <div>Admin Secret (x-admin-secret)</div>
          <input
            type="password"
            placeholder="incolla qui il segreto"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            style={{ width: '100%', padding: 8 }}
          />
        </label>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={handlePing} disabled={loading} style={{ padding: '8px 12px' }}>
            {loading ? 'Eseguo…' : 'Ping Admin API'}
          </button>

          <button onClick={handleHolidays} disabled={loading || !secret} style={{ padding: '8px 12px' }}>
            {loading ? 'Eseguo…' : 'Leggi festività'}
          </button>

          {/* 🔹 NUOVO bottone */}
          <button onClick={handleLoc} disabled={loading || !secret} style={{ padding: '8px 12px' }}>
            {loading ? 'Eseguo…' : 'Leggi Location ID'}
          </button>
        </div>

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

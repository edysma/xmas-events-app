'use client';

import React from 'react';

export default function Page() {
  const [secret, setSecret] = React.useState('');
  const [month, setMonth] = React.useState('2025-12');             // 🔹 nuovo
  const [handle, setHandle] = React.useState('viaggio-incantato'); // 🔹 nuovo
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
    await run('/api/admin-ping'); // non richiede secret
  }

  async function handleHolidays() {
    await run('/api/admin/holidays'); // richiede secret
  }

  async function handleLoc() {
    await run('/api/admin/loc'); // richiede secret
  }

  // 🔹 nuovo: eventi bundles del mese
  async function handleEventsBundles() {
    const qs = new URLSearchParams({
      month: month.trim(),
      collection: handle.trim(),
    }).toString();
    await run(`/api/admin/events-feed-bundles?${qs}`); // richiede secret
  }

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial' }}>
      <h1>Generatore Biglietti (Preview)</h1>
      <p>Mini-pannello di test per le API admin.</p>

      <div style={{ marginTop: 24, display: 'grid', gap: 12, maxWidth: 720 }}>
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

        {/* 🔹 nuovi campi */}
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr' }}>
          <label>
            <div>Mese (YYYY-MM)</div>
            <input
              type="text"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              placeholder="es. 2025-12"
              style={{ width: '100%', padding: 8 }}
            />
          </label>
          <label>
            <div>Handle evento (collection)</div>
            <input
              type="text"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="es. viaggio-incantato"
              style={{ width: '100%', padding: 8 }}
            />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={handlePing} disabled={loading} style={{ padding: '8px 12px' }}>
            {loading ? 'Eseguo…' : 'Ping Admin API'}
          </button>

          <button onClick={handleHolidays} disabled={loading || !secret} style={{ padding: '8px 12px' }}>
            {loading ? 'Eseguo…' : 'Leggi festività'}
          </button>

          <button onClick={handleLoc} disabled={loading || !secret} style={{ padding: '8px 12px' }}>
            {loading ? 'Eseguo…' : 'Leggi Location ID'}
          </button>

          {/* 🔹 nuovo bottone */}
          <button onClick={handleEventsBundles} disabled={loading || !secret} style={{ padding: '8px 12px' }}>
            {loading ? 'Eseguo…' : 'Eventi (bundles) del mese'}
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

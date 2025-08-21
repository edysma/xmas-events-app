'use client';

import { useState } from 'react';

export default function Page() {
  const [secret, setSecret] = useState('');
  const [month, setMonth] = useState('2025-12');
  const [handle, setHandle] = useState('viaggio-incantato');
  const [out, setOut] = useState('(nessun output ancora)');

  async function call(url: string, init?: RequestInit) {
    try {
      setOut('…richiesta in corso…');
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (secret) headers['x-admin-secret'] = secret;

      const res = await fetch(url, { ...(init || {}), headers });
      const text = await res.text();
      setOut(text);
    } catch (err: any) {
      setOut(`ERRORE: ${String(err?.message || err)}`);
    }
  }

  const row: React.CSSProperties = { display: 'flex', gap: 8, margin: '8px 0', flexWrap: 'wrap' };
  const input: React.CSSProperties = { width: '100%', padding: 8 };

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>Generatore Biglietti (Preview)</h1>
      <p>Mini‑pannello di test per le API admin.</p>

      <div style={row}>
        <input
          style={input}
          placeholder="incolla qui il segreto"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </div>

      <div style={row}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <label>Mese (YYYY‑MM)</label>
          <input
            style={input}
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            placeholder="2025-12"
          />
        </div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <label>Handle evento (collection)</label>
          <input
            style={input}
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="viaggio-incantato"
          />
        </div>
      </div>

      <div style={row}>
        <button onClick={() => call('/api/admin-ping')}>Ping Admin API</button>
        <button onClick={() => call('/api/admin/holidays')}>Leggi festività</button>
        <button onClick={() => call('/api/admin/loc')}>Leggi Location ID</button>
        <button
          onClick={() =>
            call(
              `/api/admin/events-feed-bundles?month=${encodeURIComponent(
                month
              )}&collection=${encodeURIComponent(handle)}`
            )
          }
        >
          Eventi (bundles) del mese
        </button>

        {/* Dry-run: anteprima, NON scrive su Shopify */}
        <button
          onClick={() =>
            call('/api/admin/generate-bundles', {
              method: 'POST',
              body: JSON.stringify({
                month,
                collection: handle,
                source: 'manual',
                dryRun: true,
              }),
            })
          }
        >
          Genera bundles (dry‑run)
        </button>
      </div>

      <fieldset style={{ border: '1px solid #ddd', padding: 12, marginTop: 8 }}>
        <legend>Generazione reale (scrive su Shopify)</legend>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input id="confirmReal" type="checkbox" />{' '}
          <span>Confermo: voglio creare/aggiornare dati reali su Shopify</span>
        </label>
        <div style={{ height: 8 }} />
        <button
          style={{ background: '#b30000', color: '#fff' }}
          onClick={() => {
            const ok = (document.getElementById('confirmReal') as HTMLInputElement)?.checked;
            if (!ok) {
              setOut('Devi spuntare la conferma per procedere.');
              return;
            }
            call('/api/admin/generate-bundles', {
              method: 'POST',
              body: JSON.stringify({
                month,
                collection: handle,
                source: 'manual',
              }),
            });
          }}
        >
          🚨 Genera bundles (REALE)
        </button>
      </fieldset>

      <h3>Risultato:</h3>
      <pre
        style={{
          background: '#111',
          color: '#0f0',
          padding: 12,
          borderRadius: 6,
          overflowX: 'auto',
        }}
      >
        {out}
      </pre>
    </main>
  );
}

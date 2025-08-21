// app/admin/generator/page.tsx
"use client";

import { useState } from "react";

export default function Page() {
  const [secret, setSecret] = useState("");
  const [month, setMonth] = useState("2025-12");
  const [handle, setHandle] = useState("viaggio-incantato");
  const [out, setOut] = useState<string>("(nessun output ancora)");

  async function call(path: string, init: RequestInit = {}) {
    setOut("…carico…");
    try {
      const res = await fetch(path, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(init.headers || {}),
          ...(secret ? { "x-admin-secret": secret } : {}),
        },
      });
      const text = await res.text();
      setOut(text || "(vuoto)");
    } catch (e: any) {
      setOut(`ERRORE: ${String(e?.message || e)}`);
    }
  }

  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Generatore Biglietti (Preview)</h1>
      <p>Mini‑pannello di test per le API admin.</p>

      <div style={{ display: "grid", gap: 12, maxWidth: 920 }}>
        <label>
          Admin Secret (x-admin-secret)
          <input
            style={{ width: "100%" }}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="incolla qui il segreto"
          />
        </label>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label>
            Mese (YYYY-MM)
            <input value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
          <label>
            Handle evento (collection)
            <input value={handle} onChange={(e) => setHandle(e.target.value)} />
          </label>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => call("/api/admin-ping")}>Ping Admin API</button>
          <button onClick={() => call("/api/admin/holidays")}>Leggi festività</button>
          <button onClick={() => call("/api/admin/loc")}>Leggi Location ID</button>
          <button
            onClick={() =>
              call(`/api/admin/events-feed-bundles?month=${encodeURIComponent(month)}&collection=${encodeURIComponent(handle)}`)
            }
          >
            Eventi (bundles) del mese
          </button>
          <button
            onClick={() =>
              call("/api/admin/generate-bundles", {
                method: "POST",
                body: JSON.stringify({
                  month,
                  collection: handle,
                  source: "manual",
                  dryRun: true, // prima prova “a secco”
                }),
              })
            }
          >
            Genera bundles (dry‑run)
          </button>
        </div>

        <div>
          <p>Risultato:</p>
          <pre style={{ background: "#111", color: "#0f0", padding: 12, whiteSpace: "pre-wrap" }}>
            {out}
          </pre>
        </div>
      </div>
    </main>
  );
}

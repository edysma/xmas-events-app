// app/admin/generator/page.tsx
"use client";

import { useState } from "react";

export default function AdminGenerator() {
  const [log, setLog] = useState<string>("(nessun output)");
  const [month, setMonth] = useState("2025-12");
  const [collection, setCollection] = useState("viaggio-incantato");

  const ADMIN_BASE = ""; // stesso dominio della pagina
  const ADMIN_SECRET = process.env.NEXT_PUBLIC_ADMIN_SECRET || "";

  async function callGenerate(dryRun: boolean) {
    setLog("Esecuzione in corso…");
    try {
      const res = await fetch(`${ADMIN_BASE}/api/admin/generate-bundles`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": ADMIN_SECRET,
        },
        body: JSON.stringify({
          month,
          collection,
          source: "manual",
          dryRun,
        }),
      });

      const text = await res.text();
      // prova a fare parse, altrimenti mostra raw
      try {
        const json = JSON.parse(text);
        setLog(JSON.stringify(json, null, 2));
      } catch {
        setLog(text || `(HTTP ${res.status})`);
      }
    } catch (err: any) {
      setLog(`Errore: ${err?.message || String(err)}`);
    }
  }

  return (
    <main style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <h1>Admin • Generator</h1>

      <div style={{ display: "grid", gap: 12, maxWidth: 500 }}>
        <label>
          Mese (YYYY-MM)
          <input
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            placeholder="2025-12"
            style={{ width: "100%", padding: 8 }}
          />
        </label>

        <label>
          Handle evento (collection)
          <input
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            placeholder="viaggio-incantato"
            style={{ width: "100%", padding: 8 }}
          />
        </label>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => callGenerate(true)}>Genera bundles (dry‑run)</button>
          <button onClick={() => callGenerate(false)}>Genera bundles (real)</button>
        </div>
      </div>

      <h3 style={{ marginTop: 24 }}>Output</h3>
      <pre
        style={{
          background: "#111",
          color: "#0f0",
          padding: 16,
          borderRadius: 8,
          minHeight: 180,
          overflow: "auto",
        }}
      >
{log}
      </pre>
    </main>
  );
}

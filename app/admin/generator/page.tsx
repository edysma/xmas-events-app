        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => call("/api/admin-ping")}>Ping Admin API</button>
          <button onClick={() => call("/api/admin/holidays")}>Leggi festività</button>
          <button onClick={() => call("/api/admin/loc")}>Leggi Location ID</button>
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

          {/* Dry-run (solo anteprima, nessuna scrittura) */}
          <button
            onClick={() =>
              call("/api/admin/generate-bundles", {
                method: "POST",
                body: JSON.stringify({
                  month,
                  collection: handle,
                  source: "manual",
                  dryRun: true,
                }),
              })
            }
          >
            Genera bundles (dry‑run)
          </button>
        </div>

        {/* Barra di sicurezza per la generazione reale */}
        <fieldset style={{ border: "1px solid #ddd", padding: 12 }}>
          <legend>Generazione reale (scrive su Shopify)</legend>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input id="confirmReal" type="checkbox" />
            <span>Confermo: voglio creare/aggiornare dati reali su Shopify</span>
          </label>
          <div style={{ height: 8 }} />
          <button
            style={{ background: "#b30000", color: "#fff" }}
            onClick={() => {
              const ok = (document.getElementById("confirmReal") as HTMLInputElement)?.checked;
              if (!ok) {
                setOut("Devi spuntare la conferma per procedere.");
                return;
              }
              call("/api/admin/generate-bundles", {
                method: "POST",
                body: JSON.stringify({
                  month,
                  collection: handle,
                  source: "manual",
                  // niente dryRun => scrive davvero
                }),
              });
            }}
          >
            🚨 Genera bundles (REALE)
          </button>
        </fieldset>

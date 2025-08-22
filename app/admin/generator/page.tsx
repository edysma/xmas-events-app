"use client";

import React, { useEffect, useMemo, useState } from "react";

type Summary = Record<string, number>;
type PreviewItem = any;

type Mode = "feed" | "manual";

const LS_SECRET = "sinflora_admin_secret";
const LS_LAST_BODY = "sinflora_admin_last_body";
const API_PATH = "/api/admin/generate-bundles";

// Util: safe JSON parse
function tryParseJSON<T = any>(txt: string, fallback: T): T {
  try {
    const v = JSON.parse(txt);
    return v as T;
  } catch {
    return fallback;
  }
}
function pretty(obj: any) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj ?? "");
  }
}

export default function AdminGeneratePage() {
  // ---------- Auth ----------
  const [adminSecret, setAdminSecret] = useState<string>("");

  // ---------- Tabs ----------
  const [mode, setMode] = useState<Mode>("feed");
  const isFeed = mode === "feed";

  // ---------- Common fields ----------
  const [dryRun, setDryRun] = useState(true);
  const [capacityPerSlot, setCapacityPerSlot] = useState<number>(50);
  const [locationId, setLocationId] = useState<string>("");
  const [templateSuffix, setTemplateSuffix] = useState<string>("bundle");
  const [tags, setTags] = useState<string>("Bundle,SeatUnit,Sinflora");
  const [description, setDescription] = useState<string>("Biglietto evento");

  // Prices JSON (per semplicità e aderenza all’API)
  const defaultPrices = {
    feriali: { adulto: 12, bambino: 8, handicap: 12 },
    friday: { adulto: 12, bambino: 8, handicap: 12 },
    saturday: { adulto: 14, bambino: 9, handicap: 14 },
    sunday: { adulto: 14, bambino: 9, handicap: 14 },
    holiday: { adulto: 16, bambino: 10, handicap: 16 },
  };
  const [pricesJSON, setPricesJSON] = useState<string>(pretty(defaultPrices));

  // ---------- FEED fields ----------
  const [month, setMonth] = useState<string>("2025-12");
  const [collection, setCollection] = useState<string>("viaggio-incantato");
  const [batchSize, setBatchSize] = useState<number>(25); // opzionale, supportato lato API

  // ---------- MANUAL fields ----------
  const [eventHandle, setEventHandle] = useState<string>("viaggio-incantato");
  const [startDate, setStartDate] = useState<string>("2025-12-05");
  const [endDate, setEndDate] = useState<string>("2025-12-06");
  const [weekdaySlots, setWeekdaySlots] = useState<string>("11:00\n11:30");
  const [weekendSlots, setWeekendSlots] = useState<string>("11:00\n11:30");
  const [fridayAsWeekend, setFridayAsWeekend] = useState<boolean>(true);
  const [exceptionsByDateJSON, setExceptionsByDateJSON] = useState<string>("{}"); // opzionale

  // ---------- Output ----------
  const [pending, setPending] = useState<boolean>(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [preview, setPreview] = useState<PreviewItem[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string>("");

  // ---------- Persist piccoli comfort ----------
  // carica da localStorage (solo client)
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const s = window.localStorage.getItem(LS_SECRET);
      if (s) setAdminSecret(s);
      // LS_LAST_BODY lo mostriamo sotto, lo leggeremo in un altro effect
    } catch {
      // ignora
    }
  }, []);

  // salva secret su localStorage (solo client)
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(LS_SECRET, adminSecret ?? "");
    } catch {
      // ignora
    }
  }, [adminSecret]);

  // ---------- Helpers ----------
  function parseLines(txt: string) {
    return txt
      .split(/\r?\n/g)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function buildBody() {
    const prices = tryParseJSON(pricesJSON, defaultPrices);
    const tagsArr = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    if (isFeed) {
      const body: any = {
        month,
        collection,
        source: "manual", // coerente con backend attuale
        dryRun,
        capacityPerSlot,
        locationId: locationId || null,
        templateSuffix: templateSuffix || undefined,
        tags: tagsArr.length ? tagsArr : undefined,
        description: description || undefined,
        "prices€": prices,
        // Avanzato opzionale:
        batchSize: Math.max(1, Math.min(batchSize || 25, 50)),
      };
      return body;
    } else {
      const body: any = {
        source: "manual",
        eventHandle,
        startDate,
        endDate,
        weekdaySlots: parseLines(weekdaySlots),
        weekendSlots: parseLines(weekendSlots),
        fridayAsWeekend,
        capacityPerSlot,
        locationId: locationId || null,
        templateSuffix: templateSuffix || undefined,
        tags: tagsArr.length ? tagsArr : undefined,
        description: description || undefined,
        "prices€": prices,
        // opzionale
        exceptionsByDate: tryParseJSON(exceptionsByDateJSON, undefined),
        dryRun,
      };
      return body;
    }
  }

  async function doCall() {
    setPending(true);
    setSummary(null);
    setPreview([]);
    setWarnings([]);
    setError("");

    const body = buildBody();

    // salva ultimo payload (solo client)
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(LS_LAST_BODY, pretty(body));
      } catch {
        // ignora
      }
    }

    try {
      const res = await fetch(API_PATH, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": adminSecret || "",
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok || data?.ok === false) {
        setError(data?.detail || data?.error || `HTTP ${res.status}`);
        return;
      }
      setSummary(data?.summary || null);
      setPreview(Array.isArray(data?.preview) ? data.preview : []);
      setWarnings(Array.isArray(data?.warnings) ? data.warnings : []);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setPending(false);
    }
  }

  // Per pulsanti Preview/Crea cambiamo solo dryRun al volo
  async function onPreview() {
    const was = dryRun;
    try {
      setDryRun(true);
      await doCall();
    } finally {
      setDryRun(was);
    }
  }
  async function onCreate() {
    const was = dryRun;
    try {
      setDryRun(false);
      await doCall();
    } finally {
      setDryRun(was);
    }
  }

  // ---------- Ultimo payload (mostra solo su client) ----------
  const [lastPayload, setLastPayload] = useState<string>("");
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const v = window.localStorage.getItem(LS_LAST_BODY) || "";
      setLastPayload(v);
    } catch {
      setLastPayload("");
    }
  }, [summary, preview, warnings, error]); // aggiorno quando arrivano risultati

  // Render helpers per preview generico (supporta sia preview “feed” che “manuale”)
  function renderPreviewRow(item: any, idx: number) {
    // Due formati supportati:
    // 1) Feed preview: { date, time, dayType, type?, bundleVariantIdGid? }
    // 2) Manual/real: { date,time,dayType, seatProductId?, bundleProductId?, variantMap? }
    const type = item?.type || "";
    const adult = item?.variantMap?.adulto || "";
    const kid = item?.variantMap?.bambino || "";
    const handicap = item?.variantMap?.handicap || "";
    const bundleVar = item?.bundleVariantIdGid || "";

    return (
      <tr key={idx} className="border-b last:border-0">
        <td className="py-2 px-2">{String(item?.date ?? "")}</td>
        <td className="py-2 px-2">{String(item?.time ?? "")}</td>
        <td className="py-2 px-2">{String(item?.dayType ?? "")}</td>
        <td className="py-2 px-2">{type || "-"}</td>
        <td className="py-2 px-2 text-xs break-all">{String(item?.seatProductId ?? "-")}</td>
        <td className="py-2 px-2 text-xs break-all">{String(item?.bundleProductId ?? "-")}</td>
        <td className="py-2 px-2 text-xs break-all">{adult || "-"}</td>
        <td className="py-2 px-2 text-xs break-all">{kid || "-"}</td>
        <td className="py-2 px-2 text-xs break-all">{handicap || "-"}</td>
        <td className="py-2 px-2 text-xs break-all">{bundleVar || "-"}</td>
      </tr>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Sinflora — Admin Generate</h1>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={adminSecret}
              onChange={(e) => setAdminSecret(e.target.value)}
              className="rounded-xl border px-3 py-2 w-64"
              placeholder="Admin secret"
            />
            <label className="text-sm inline-flex items-center gap-2">
              <input className="size-4" type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
              Dry‑run
            </label>
          </div>
        </header>

        {/* Tabs */}
        <div className="bg-white rounded-2xl shadow-sm border p-4">
          <div className="flex gap-2 mb-4">
            <button
              className={`px-3 py-2 rounded-xl border ${isFeed ? "bg-black text-white" : ""}`}
              onClick={() => setMode("feed")}
            >
              Feed
            </button>
            <button
              className={`px-3 py-2 rounded-xl border ${!isFeed ? "bg-black text-white" : ""}`}
              onClick={() => setMode("manual")}
            >
              Manuale
            </button>
          </div>

          {isFeed ? (
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-gray-600">Month (YYYY-MM)</label>
                <input value={month} onChange={(e) => setMonth(e.target.value)} className="w-full mt-1 rounded-xl border px-3 py-2" />
              </div>
              <div>
                <label className="text-sm text-gray-600">Collection (handle)</label>
                <input value={collection} onChange={(e) => setCollection(e.target.value)} className="w-full mt-1 rounded-xl border px-3 py-2" />
              </div>
              <div>
                <label className="text-sm text-gray-600">Capienza per slot</label>
                <input
                  type="number"
                  value={capacityPerSlot}
                  onChange={(e) => setCapacityPerSlot(parseInt(e.target.value || "0", 10))}
                  className="w-full mt-1 rounded-xl border px-3 py-2"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Batch size (default 25)</label>
                <input
                  type="number"
                  value={batchSize}
                  onChange={(e) => setBatchSize(parseInt(e.target.value || "25", 10))}
                  className="w-full mt-1 rounded-xl border px-3 py-2"
                  min={1}
                  max={50}
                />
              </div>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-gray-600">Event handle</label>
                <input value={eventHandle} onChange={(e) => setEventHandle(e.target.value)} className="w-full mt-1 rounded-xl border px-3 py-2" />
              </div>
              <div>
                <label className="text-sm text-gray-600">Start date</label>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full mt-1 rounded-xl border px-3 py-2" />
              </div>
              <div>
                <label className="text-sm text-gray-600">End date</label>
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-full mt-1 rounded-xl border px-3 py-2" />
              </div>
              <div className="md:col-span-2 grid md:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-gray-600">Weekday slots (uno per riga)</label>
                  <textarea
                    rows={3}
                    value={weekdaySlots}
                    onChange={(e) => setWeekdaySlots(e.target.value)}
                    className="w-full mt-1 rounded-xl border px-3 py-2"
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-600">Weekend slots (uno per riga)</label>
                  <textarea
                    rows={3}
                    value={weekendSlots}
                    onChange={(e) => setWeekendSlots(e.target.value)}
                    className="w-full mt-1 rounded-xl border px-3 py-2"
                  />
                </div>
              </div>
              <div className="md:col-span-2">
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={fridayAsWeekend} onChange={(e) => setFridayAsWeekend(e.target.checked)} />
                  Venerdì usa prezzi weekend
                </label>
              </div>
              <div className="md:col-span-2">
                <label className="text-sm text-gray-600">Eccezioni per data (JSON) — opzionale</label>
                <textarea
                  rows={3}
                  value={exceptionsByDateJSON}
                  onChange={(e) => setExceptionsByDateJSON(e.target.value)}
                  className="w-full mt-1 rounded-xl border px-3 py-2 font-mono text-sm"
                  placeholder={`{\n  "2025-12-08": { "adulto": 16, "bambino": 10, "handicap": 16 }\n}`}
                />
              </div>
            </div>
          )}
        </div>

        {/* Metadati comuni */}
        <div className="bg-white rounded-2xl shadow-sm border p-4 grid md:grid-cols-2 gap-4">
          <div>
            <label className="text-sm text-gray-600">Location ID (opzionale)</label>
            <input value={locationId} onChange={(e) => setLocationId(e.target.value)} className="w-full mt-1 rounded-xl border px-3 py-2" />
          </div>
          <div>
            <label className="text-sm text-gray-600">Template suffix</label>
            <input value={templateSuffix} onChange={(e) => setTemplateSuffix(e.target.value)} className="w-full mt-1 rounded-xl border px-3 py-2" />
          </div>
          <div className="md:col-span-2">
            <label className="text-sm text-gray-600">Tag (separate da virgola)</label>
            <input value={tags} onChange={(e) => setTags(e.target.value)} className="w-full mt-1 rounded-xl border px-3 py-2" />
          </div>
          <div className="md:col-span-2">
            <label className="text-sm text-gray-600">Descrizione</label>
            <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} className="w-full mt-1 rounded-xl border px-3 py-2" />
          </div>
          <div className="md:col-span-2">
            <label className="text-sm text-gray-600">Prezzi (JSON)</label>
            <textarea
              rows={6}
              value={pricesJSON}
              onChange={(e) => setPricesJSON(e.target.value)}
              className="w-full mt-1 rounded-xl border px-3 py-2 font-mono text-sm"
              placeholder={pretty(defaultPrices)}
            />
            <p className="text-xs text-gray-500 mt-1">
              Struttura attesa: <code>feriali</code>, <code>friday</code>, <code>saturday</code>, <code>sunday</code>, <code>holiday</code>. Valute in €.
            </p>
          </div>
        </div>

        {/* Azioni */}
        <div className="flex items-center gap-3">
          <button
            onClick={onPreview}
            disabled={pending}
            className="rounded-xl bg-gray-900 text-white px-4 py-2 disabled:opacity-50"
          >
            {pending ? "…" : "Preview (dryRun)"}
          </button>
          <button
            onClick={onCreate}
            disabled={pending}
            className="rounded-xl bg-green-600 text-white px-4 py-2 disabled:opacity-50"
          >
            {pending ? "…" : "Crea (esegui davvero)"}
          </button>
        </div>

        {/* Output */}
        {(summary || warnings.length || error || preview.length) ? (
          <section className="grid lg:grid-cols-3 gap-6">
            {/* Summary */}
            <div className="bg-white rounded-2xl shadow-sm border p-4">
              <h3 className="font-medium mb-2">Summary</h3>
              {summary ? (
                <ul className="text-sm space-y-1">
                  {Object.entries(summary).map(([k, v]) => (
                    <li key={k}>
                      <b>{k}</b>: {v}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-gray-500">Nessun risultato.</p>
              )}

              {warnings.length > 0 && (
                <>
                  <h4 className="font-medium mt-4 mb-1">Warnings</h4>
                  <ul className="text-xs list-disc pl-4 space-y-1">
                    {warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </>
              )}

              {error && (
                <>
                  <h4 className="font-medium mt-4 mb-1 text-red-600">Errore</h4>
                  <pre className="text-xs bg-red-50 border border-red-200 rounded-lg p-2 whitespace-pre-wrap break-all">
                    {error}
                  </pre>
                </>
              )}
            </div>

            {/* Preview */}
            <div className="bg-white rounded-2xl shadow-sm border p-4 lg:col-span-2">
              <h3 className="font-medium mb-2">Preview (prime righe)</h3>
              {preview.length === 0 ? (
                <p className="text-sm text-gray-500">Vuoto.</p>
              ) : (
                <div className="overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left border-b">
                        <th className="py-2 px-2">Date</th>
                        <th className="py-2 px-2">Time</th>
                        <th className="py-2 px-2">DayType</th>
                        <th className="py-2 px-2">Type</th>
                        <th className="py-2 px-2">Seat Product</th>
                        <th className="py-2 px-2">Bundle Product</th>
                        <th className="py-2 px-2">Adulto</th>
                        <th className="py-2 px-2">Bambino</th>
                        <th className="py-2 px-2">Handicap</th>
                        <th className="py-2 px-2">BundleVar GID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.slice(0, 100).map(renderPreviewRow)}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        ) : null}

        {/* Ultimo payload inviato (comodo per debug) */}
        <div className="bg-white rounded-2xl shadow-sm border p-4">
          <h3 className="font-medium mb-2">Ultimo payload inviato</h3>
          <pre className="text-xs bg-gray-50 border rounded-lg p-3 whitespace-pre-wrap break-all">
            {lastPayload || "(vuoto)"}
          </pre>
        </div>
      </div>
    </div>
  );
}

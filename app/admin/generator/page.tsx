"use client";

import { useMemo, useState, useEffect, useRef } from "react";

/**
 * Admin Generator — UI v2
 * - Persistenza Admin Secret in localStorage
 * - Integrazione con /api/admin/generate-bundles (source:"manual")
 * - NESSUNA abbreviazione. File completo.
 */

const LS_ADMIN_SECRET = "sinflora_admin_secret";
const LS_BATCH_SIZE = "sinflora_batch_size";
const LS_LAST_PAYLOAD = "sinflora_last_payload";

/* ----------------------------- Tipi locali (frontend) ----------------------------- */

type Triple = { adulto?: number; bambino?: number; handicap?: number };

type PriceTierEuro = {
  holiday?: number | Triple;
  saturday?: number | Triple;
  sunday?: number | Triple;
  friday?: number | Triple;
  weekday?: {
    unico?: number;
    perDay?: {
      mon?: number | Triple;
      tue?: number | Triple;
      wed?: number | Triple;
      thu?: number | Triple;
    };
  };
};

type PricesEuro = {
  holiday?: PriceTierEuro | number | Triple;
  saturday?: PriceTierEuro | number | Triple;
  sunday?: PriceTierEuro | number | Triple;
  friday?: PriceTierEuro | number | Triple;
  weekday?: {
    unico?: number;
    perDay?: {
      mon?: PriceTierEuro | number | Triple;
      tue?: PriceTierEuro | number | Triple;
      wed?: PriceTierEuro | number | Triple;
      thu?: PriceTierEuro | number | Triple;
    };
  };
};

type GenerateBundlesResponse = {
  ok: boolean;
  error?: string;
  detail?: string;
  summary?: {
    seatsCreated?: number;
    bundlesCreated?: number;
    variantsCreated?: number;
    inventoryAdjusted?: number;
    relationshipsUpserted?: number;
    pricesUpdated?: number;
  };
  warnings?: string[];
  preview?: any[];
};

/* ----------------------------- Component ----------------------------- */

export default function AdminGeneratorUIV2() {
  // -----------------------------
  // Stato principale
  // -----------------------------
  const [adminSecret, setAdminSecret] = useState(""); // Admin Secret (persistente)

  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [timesText, setTimesText] = useState("");

  const [productTitleBase, setProductTitleBase] = useState(""); // Posti (nascosti) — usato come eventHandle lato API
  const [capacityPerSlot, setCapacityPerSlot] = useState<number>(0);

  const [bundleTitleBase, setBundleTitleBase] = useState(""); // Biglietti (visibili)
  const [dryRun, setDryRun] = useState(true);
  const [fridayAsWeekend, setFridayAsWeekend] = useState(false);

  const [batchSize, setBatchSize] = useState<number>(25);
  const [isRunning, setIsRunning] = useState(false);
  const [aborted, setAborted] = useState(false);
  const abortRef = useRef(false);

  const [progress, setProgress] = useState<{ done: number; total: number; batchIndex: number; batchesTotal: number }>({
    done: 0, total: 0, batchIndex: 0, batchesTotal: 0
  });
  const [logLines, setLogLines] = useState<string[]>([]);
  const [aggCounts, setAgg] = useState<{ seatsCreated: number; bundlesCreated: number; variantsCreated: number }>(
    { seatsCreated: 0, bundlesCreated: 0, variantsCreated: 0 }
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Prezzi — toggle "unico" + tripla (Adulto/Bambino/Handicap)
  const [holidayUnico, setHolidayUnico] = useState(false);
  const [holidayUnicoPrice, setHolidayUnicoPrice] = useState<number>(0);
  const [holidayTriple, setHolidayTriple] = useState<Triple>({});

  const [satUnico, setSatUnico] = useState(false);
  const [satUnicoPrice, setSatUnicoPrice] = useState<number>(0);
  const [satTriple, setSatTriple] = useState<Triple>({});

  const [sunUnico, setSunUnico] = useState(false);
  const [sunUnicoPrice, setSunUnicoPrice] = useState<number>(0);
  const [sunTriple, setSunTriple] = useState<Triple>({});

  const [friUnico, setFriUnico] = useState(false);
  const [friUnicoPrice, setFriUnicoPrice] = useState<number>(0);
  const [friTriple, setFriTriple] = useState<Triple>({});

  const [ferUnico, setFerUnico] = useState(false);
  const [ferUnicoPrice, setFerUnicoPrice] = useState<number>(0);

  const [ferMonUnico, setFerMonUnico] = useState(false);
  const [ferMonUnicoPrice, setFerMonUnicoPrice] = useState<number>(0);
  const [ferMonTriple, setFerMonTriple] = useState<Triple>({});

  const [ferTueUnico, setFerTueUnico] = useState(false);
  const [ferTueUnicoPrice, setFerTueUnicoPrice] = useState<number>(0);
  const [ferTueTriple, setFerTueTriple] = useState<Triple>({});

  const [ferWedUnico, setFerWedUnico] = useState(false);
  const [ferWedUnicoPrice, setFerWedUnicoPrice] = useState<number>(0);
  const [ferWedTriple, setFerWedTriple] = useState<Triple>({});

  const [ferThuUnico, setFerThuUnico] = useState(false);
  const [ferThuUnicoPrice, setFerThuUnicoPrice] = useState<number>(0);
  const [ferThuTriple, setFerThuTriple] = useState<Triple>({});

  // Persistenza admin secret
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(LS_ADMIN_SECRET);
      if (v) setAdminSecret(v);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(LS_ADMIN_SECRET, adminSecret ?? "");
    } catch {
      // ignore
    }
  }, [adminSecret]);

  // Persistenza BatchSize
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LS_BATCH_SIZE);
      const v = raw ? parseInt(raw, 10) : NaN;
      if (!Number.isNaN(v) && v > 0) setBatchSize(v);
    } catch {}
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(LS_BATCH_SIZE, String(batchSize || 25)); } catch {}
  }, [batchSize]);

  // Sync abort ref
  useEffect(() => { abortRef.current = aborted; }, [aborted]);

  // -----------------------------
  // Helpers date/orari
  // -----------------------------
  // Weekday helper Europe/Rome (1=Mon..7=Sun)
  function weekdayRome(date: string): number {
    const name = new Intl.DateTimeFormat("it-IT", { weekday: "short", timeZone: "Europe/Rome" })
      .format(new Date(date + "T12:00:00Z"))
      .toLowerCase();
    const map: Record<string, number> = { lun:1, mar:2, mer:3, gio:4, ven:5, sab:6, dom:7 };
    return map[name] ?? 0;
  }

  function listDatesBetween(start: string, end: string): string[] {
    if (!start || !end) return [];
    const s = new Date(start + "T00:00:00Z");
    const e = new Date(end + "T00:00:00Z");
    if (isNaN(s.getTime()) || isNaN(e.getTime())) return [];
    const out: string[] = [];
    const d = new Date(s);
    while (d.getTime() <= e.getTime()) {
      out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }
  function parseTimesWithValidation(text: string): { valid: string[]; invalid: string[]; duplicatesRemoved: number } {
    const raw = (text || "")
      .split(/[\n,;\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const deduped: string[] = [];
    const seen = new Set<string>();
    const invalid: string[] = [];
    for (const r of raw) {
      if (!/^\d{2}:\d{2}$/.test(r)) { invalid.push(r); continue; }
      const [H, M] = r.split(":").map((x) => parseInt(x, 10));
      if (isNaN(H) || isNaN(M) || H < 0 || H > 23 || M < 0 || M > 59) { invalid.push(r); continue; }
      if (seen.has(r)) continue;
      seen.add(r);
      deduped.push(r);
    }
    deduped.sort();
    const invalidCount = invalid.length;
    return { valid: deduped, invalid, duplicatesRemoved: raw.length - deduped.length - invalidCount };
  }

  // Calcoli memoizzati
  const allDates = useMemo(() => listDatesBetween(dateStart, dateEnd), [dateStart, dateEnd]);
  const excludedSet = useMemo(() => new Set(excluded), [excluded]);
  const effectiveDates = useMemo(() => allDates.filter((d) => !excludedSet.has(d)), [allDates, excludedSet]);
  const timesInfo = useMemo(() => parseTimesWithValidation(timesText), [timesText]);

  const canRunBase =
    productTitleBase.trim() &&
    bundleTitleBase.trim() &&
    effectiveDates.length > 0 &&
    timesInfo.valid.length > 0 &&
    capacityPerSlot > 0;
  const canRun = Boolean(canRunBase && timesInfo.invalid.length === 0 && adminSecret.trim().length > 0);

  const comboCount = useMemo(
    () => effectiveDates.length * timesInfo.valid.length,
    [effectiveDates.length, timesInfo.valid.length]
  );

  // Sample carrello
  const sampleDate = effectiveDates[0] || "";
  const sampleTime = timesInfo.valid[0] || "";
  function isUnicoForSample(sampleDate: string) {
    // Giornata campione: preferisci holiday > sat > sun > fri > weekday
    const w = new Date(sampleDate + "T12:00:00Z").getUTCDay(); // 0=Dom ... 6=Sab
    if (holidayUnico) return true;
    if (w === 6) return satUnico;
    if (w === 0) return sunUnico;
    if (w === 5) {
      if (fridayAsWeekend) return friUnico; // venerdì come weekend
      return ferUnico; // generale Lun–Gio
    }
    return false;
  }
  const sampleTitle =
    bundleTitleBase && sampleDate && sampleTime
      ? `${bundleTitleBase} — ${sampleDate.split("-").reverse().join("/")} ${sampleTime}`
      : "(compila titolo, date e orari)";
  const sampleVariant = isUnicoForSample(sampleDate) ? "Biglietto unico" : "Adulto / Bambino / Handicap";

  // UI: toggle esclusione date
  function toggleExclude(d: string) {
    setExcluded((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  }

  // -----------------------------
  // Build prezzi per API body
  // -----------------------------
  function toTier(unico: boolean, unicoPrice: number, triple: Triple): PriceTierEuro | undefined {
    if (unico) {
      if (typeof unicoPrice === "number" && unicoPrice > 0) return { unico: round2(unicoPrice) };
      return undefined;
    }
    const p: PriceTierEuro = {};
    if (typeof triple?.adulto === "number" && triple.adulto > 0) p.adulto = round2(triple.adulto);
    if (typeof triple?.bambino === "number" && triple.bambino > 0) p.bambino = round2(triple.bambino);
    if (typeof triple?.handicap === "number" && triple.handicap > 0) p.handicap = round2(triple.handicap);
    if (!("adulto" in p) && !("bambino" in p) && !("handicap" in p)) return undefined;
    return p;
  }

  function round2(v: number) {
    return Math.round((v + Number.EPSILON) * 100) / 100;
  }

  function buildPrices(): PricesEuro {
    const prices: PricesEuro = {};

    const hol = toTier(holidayUnico, holidayUnicoPrice, holidayTriple);
    if (hol) prices.holiday = hol;

    const sat = toTier(satUnico, satUnicoPrice, satTriple);
    if (sat) prices.saturday = sat;

    const sun = toTier(sunUnico, sunUnicoPrice, sunTriple);
    if (sun) prices.sunday = sun;

    const fri = toTier(friUnico, friUnicoPrice, friTriple);
    if (fri) prices.friday = fri;

    // Feriali generali + per-day Lunedì–Giovedì
    const fer = toTier(ferUnico, ferUnicoPrice, {});
    if (fer) {
      prices.weekday = { unico: (fer as any).unico } as any;
    }

    // per-day Mon–Thu
    const perDay: any = {};
    const mon = toTier(ferMonUnico, ferMonUnicoPrice, ferMonTriple);
    if (mon) perDay.mon = mon;
    const tue = toTier(ferTueUnico, ferTueUnicoPrice, ferTueTriple);
    if (tue) perDay.tue = tue;
    const wed = toTier(ferWedUnico, ferWedUnicoPrice, ferWedTriple);
    if (wed) perDay.wed = wed;
    const thu = toTier(ferThuUnico, ferThuUnicoPrice, ferThuTriple);
    if (thu) perDay.thu = thu;

    if (Object.keys(perDay).length > 0) {
      if (!prices.weekday) prices.weekday = {} as any;
      (prices.weekday as any).perDay = perDay;
    }

    return prices;
  }

  // Slots separati per weekday/weekend
  const weekdaySlots = useMemo(() => {
    // Lunedì-Giovedì + (Venerdì se non weekend)
    return timesInfo.valid;
  }, [timesInfo.valid]);

  const weekendSlots = useMemo(() => {
    // Sabato/Domenica/Festivi + (Venerdì se fridayAsWeekend)
    return timesInfo.valid;
  }, [timesInfo.valid]);

  // -----------------------------
  // Call API generate-bundles (manual) — batching + retry/backoff
  // -----------------------------
  async function handleCreateBundles() {
    if (!canRun || isRunning) return;
    setIsRunning(true);
    setAborted(false);
    abortRef.current = false;
    setErrorMsg(null);
    setLogLines([]);
    setAgg({ seatsCreated: 0, bundlesCreated: 0, variantsCreated: 0 });

    try {
      const prices = buildPrices();

      const bodyBase = {
        source: "manual" as const,
        dryRun,
        eventHandle: productTitleBase, // lato API usiamo eventHandle come base
        startDate: dateStart,
        endDate: dateEnd,
        weekdaySlots,
        weekendSlots,
        "prices€": prices,
        fridayAsWeekend,
        capacityPerSlot,
        templateSuffix: templateSuffix || undefined,
        imageUrl: imageUrl || undefined,
        description: desc || undefined,
        tags: tags
          ? tags.split(",").map((t) => t.trim()).filter(Boolean)
          : undefined,
      };

      try { window.localStorage.setItem(LS_LAST_PAYLOAD, JSON.stringify(bodyBase)); } catch {}

      // Fetch public holidays to match server day-type logic
      const holidaysSet: Set<string> = new Set(
        await (async () => {
          try {
            const r = await fetch("/api/admin/holidays", { headers: { "x-admin-secret": adminSecret || "" } });
            const j = await r.json();
            if (r.ok && j?.ok && Array.isArray(j.dates)) return j.dates as string[];
          } catch {}
          return [];
        })()
      );

      // Build date list
      const dates = listDatesBetween(dateStart, dateEnd);

      const slotCountForDate = (d: string) => {
        const w = weekdayRome(d);
        const isFri = w === 5;
        const isSat = w === 6;
        const isSun = w === 7;
        const isHol = holidaysSet.has(d);
        const weekendLike = isHol || isSat || isSun || (isFri && fridayAsWeekend);
        const arr = weekendLike ? weekendSlots : weekdaySlots;
        return Array.isArray(arr) ? arr.length : 0;
      };

      const total = dates.reduce((sum, d) => sum + slotCountForDate(d), 0);
      setProgress({ done: 0, total, batchIndex: 0, batchesTotal: 0 });

      // Group in batches of <= batchSize slots with consecutive dates
      const target = Math.max(1, Number(batchSize) || 25);
      const batches: Array<{ start: string; end: string; slots: number }> = [];
      let i = 0;
      while (i < dates.length) {
        let start = dates[i];
        let j = i;
        let count = 0;
        while (j < dates.length) {
          const add = slotCountForDate(dates[j]);
          if (count > 0 && count + add > target) break;
          if (count === 0 && add > target) { // single heavy day
            count = add; j++; break;
          }
          count += add; j++;
        }
        const end = dates[j - 1];
        batches.push({ start, end, slots: count });
        i = j;
      }
      setProgress((p) => ({ ...p, batchesTotal: batches.length }));

      // Helpers
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const appendLog = (line: string) =>
        setLogLines((prev) => {
          const arr = [...prev, `[${new Date().toLocaleTimeString()}] ${line}`];
          return arr.length > 30 ? arr.slice(arr.length - 30) : arr;
        });

      let processed = 0;
      let batchIdx = 0;
      const agg = { seatsCreated: 0, bundlesCreated: 0, variantsCreated: 0 } as any;

      for (const b of batches) {
        if (abortRef.current) break;
        batchIdx++;

        let attempt = 0;
        let success = false;
        let lastErr: any = null;

        while (!success && attempt < 4) {
          attempt++;
          const delayMs = Math.pow(2, attempt - 1) * 1000; // 1s,2s,4s,8s

          try {
            appendLog(`Batch ${batchIdx}/${batches.length} — ${b.start} → ${b.end} (≈${b.slots} slot) — tentativo ${attempt}`);
            const res = await fetch("/api/admin/generate-bundles", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-admin-secret": adminSecret || "",
              },
              body: JSON.stringify({ ...bodyBase, startDate: b.start, endDate: b.end }),
            });

            let data: GenerateBundlesResponse | null = null;
            try { data = (await res.json()) as GenerateBundlesResponse; } catch {}

            if (!res.ok || !data?.ok) {
              const code = data?.error || `${res.status}`;
              const detail = data?.detail || res.statusText || "Errore";
              if (res.status === 429 || res.status >= 500 || code === "rate_limited") {
                appendLog(`Retry: ${code} — ${detail}`);
                lastErr = detail;
                if (attempt < 4) await sleep(delayMs);
                continue;
              } else {
                throw new Error(`${code} — ${detail}`);
              }
            }

            // Success
            success = true;
            const s: any = data.summary || {};
            agg.seatsCreated += Number(s.seatsCreated || 0);
            agg.bundlesCreated += Number(s.bundlesCreated || 0);
            agg.variantsCreated += Number(s.variantsCreated || 0);

            processed += b.slots;
            setProgress({ done: Math.min(processed, total), total, batchIndex: batchIdx, batchesTotal: batches.length });
            appendLog(`OK: ${b.start} → ${b.end} — creati S:${s.seatsCreated||0} B:${s.bundlesCreated||0} V:${s.variantsCreated||0}`);
          } catch (e: any) {
            lastErr = e?.message || String(e);
            if (attempt < 4) {
              appendLog(`Errore: ${lastErr} — nuovo tentativo tra ${delayMs/1000}s`);
              await sleep(delayMs);
            }
          }
        }

        if (!success) {
          setAgg(agg);
          setIsRunning(false);
          setErrorMsg(`Batch ${batchIdx} fallito: ${lastErr || "sconosciuto"}`);
          setModalMsg(`Errore: batch ${batchIdx} — ${lastErr || "sconosciuto"}`);
          return;
        }
      }

      setAgg(agg);
      const pct = total ? Math.round((Math.min(processed, total) / total) * 100) : 0;
      setModalMsg(abortRef.current
        ? `Operazione interrotta. Completato ~${pct}%`
        : `Completato! Slots: ${processed}/${total}\nCreati: ${JSON.stringify(agg)}`
      );
    } catch (err: any) {
      console.error("Errore Bundles:", err);
      setModalMsg(`Errore Bundles: ${String(err?.message || err)}`);
    } finally {
      setIsRunning(false);
    }
  }

  // -----------------------------
  // TEST automatici (console) per parser orari
  // -----------------------------
  useEffect(() => {
    const ok = (name: string, cond: boolean) => console.assert(cond, `Test fallito: ${name}`);
    const t1 = parseTimesWithValidation("");
    ok("vuoto", t1.valid.length === 0 && t1.invalid.length >= 0);
  }, []);

  // -----------------------------
  // UI
  // -----------------------------
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto p-5 space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Generatore biglietti — Sinflora Xmas</h1>
          <div className="flex items-center gap-2">
            <input
              type="password"
              placeholder="Admin Secret"
              value={adminSecret}
              onChange={(e) => setAdminSecret(e.target.value)}
              className="rounded-xl border px-3 py-2 w-64"
            />
          </div>
        </header>

        {/* Input base */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white rounded-2xl shadow-sm border p-5 space-y-4">
            <h3 className="font-medium">Calendario</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-gray-600">Data inizio</label>
                <input type="date" value={dateStart} onChange={(e) => setDateStart(e.target.value)} className="w-full mt-1 rounded-xl border px-3 py-2" />
              </div>
              <div>
                <label className="text-sm text-gray-600">Data fine</label>
                <input type="date" value={dateEnd} onChange={(e) => setDateEnd(e.target.value)} className="w-full mt-1 rounded-xl border px-3 py-2" />
              </div>
            </div>

            {/* Calendario semplice (grid di date) */}
            <div>
              <h4 className="font-medium mb-1">Escludi date</h4>
              <div className="grid grid-cols-7 gap-2 max-h-40 overflow-auto">
                {listDatesBetween(dateStart, dateEnd).map((d) => {
                  const isEx = excluded.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => toggleExclude(d)}
                      className={`text-xs px-2 py-1 rounded-lg border ${isEx ? "bg-red-50 border-red-300 text-red-700" : "bg-gray-50"}`}
                    >
                      {d.split("-").reverse().join("/")}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border p-5 space-y-4">
            <h3 className="font-medium">Slot & Capacità</h3>
            <div>
              <label className="text-sm text-gray-600">Orari (uno per riga o separati da virgole)</label>
              <textarea
                value={timesText}
                onChange={(e) => setTimesText(e.target.value)}
                placeholder="Es. 10:00\n11:30\n15:00"
                className="w-full h-28 rounded-xl border p-3"
              />
              {timesInfo.invalid.length > 0 && (
                <p className="text-xs text-red-600 mt-1">Orari non validi: {timesInfo.invalid.join(", ")}</p>
              )}
              {timesInfo.valid.length > 0 && (
                <p className="text-xs text-gray-600 mt-1">Orari validi (ordinati): {timesInfo.valid.join(", ")}</p>
              )}
            </div>
            <div>
              <label className="text-sm text-gray-600">Capacità per slot</label>
              <input
                type="number"
                value={capacityPerSlot || 0}
                onChange={(e) => setCapacityPerSlot(parseInt(e.target.value || "0", 10))}
                className="w-full rounded-xl border px-3 py-2"
              />
            </div>
          </div>
        </section>

        {/* Dettagli prodotto + Prezzi */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="bg-white rounded-2xl shadow-sm border p-5 space-y-4 lg:col-span-2">
            <h3 className="font-medium">Dettagli & Prezzi</h3>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-gray-600">Titolo base (posti/handle evento)</label>
                <input
                  type="text"
                  value={productTitleBase}
                  onChange={(e) => setProductTitleBase(e.target.value)}
                  className="w-full rounded-xl border px-3 py-2"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Titolo base (bundle visibile)</label>
                <input
                  type="text"
                  value={bundleTitleBase}
                  onChange={(e) => setBundleTitleBase(e.target.value)}
                  className="w-full rounded-xl border px-3 py-2"
                />
              </div>
            </div>

            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> Dry‑run (anteprima)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={fridayAsWeekend} onChange={(e) => setFridayAsWeekend(e.target.checked)} /> Venerdì come weekend
              </label>
            </div>

            {/* Prezzi sintetici (holiday/sat/sun/fri/weekday + per-day) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <DayCard title="Festivi">
                <SectionPricesInner
                  unico={holidayUnico}
                  setUnico={setHolidayUnico}
                  unicoPrice={holidayUnicoPrice}
                  setUnicoPrice={setHolidayUnicoPrice}
                  triple={holidayTriple}
                  setTriple={setHolidayTriple}
                />
              </DayCard>
              <DayCard title="Sabato">
                <SectionPricesInner
                  unico={satUnico}
                  setUnico={setSatUnico}
                  unicoPrice={satUnicoPrice}
                  setUnicoPrice={setSatUnicoPrice}
                  triple={satTriple}
                  setTriple={setSatTriple}
                />
              </DayCard>
              <DayCard title="Domenica">
                <SectionPricesInner
                  unico={sunUnico}
                  setUnico={setSunUnico}
                  unicoPrice={sunUnicoPrice}
                  setUnicoPrice={setSunUnicoPrice}
                  triple={sunTriple}
                  setTriple={setSunTriple}
                />
              </DayCard>
              <DayCard title="Venerdì">
                <SectionPricesInner
                  unico={friUnico}
                  setUnico={setFriUnico}
                  unicoPrice={friUnicoPrice}
                  setUnicoPrice={setFriUnicoPrice}
                  triple={friTriple}
                  setTriple={setFriTriple}
                />
              </DayCard>
            </div>

            <h4 className="font-medium mt-4">Feriali (Lun–Gio) + per‑giorno</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <DayCard title="Generale feriali">
                <SectionPricesInner
                  unico={ferUnico}
                  setUnico={setFerUnico}
                  unicoPrice={ferUnicoPrice}
                  setUnicoPrice={setFerUnicoPrice}
                  triple={{}}
                  setTriple={() => {}}
                />
              </DayCard>
              <div className="grid grid-cols-2 gap-4">
                <DayCard title="Lunedì">
                  <SectionPricesInner
                    unico={ferMonUnico}
                    setUnico={setFerMonUnico}
                    unicoPrice={ferMonUnicoPrice}
                    setUnicoPrice={setFerMonUnicoPrice}
                    triple={ferMonTriple}
                    setTriple={setFerMonTriple}
                  />
                </DayCard>
                <DayCard title="Martedì">
                  <SectionPricesInner
                    unico={ferTueUnico}
                    setUnico={setFerTueUnico}
                    unicoPrice={ferTueUnicoPrice}
                    setUnicoPrice={setFerTueUnicoPrice}
                    triple={ferTueTriple}
                    setTriple={setFerTueTriple}
                  />
                </DayCard>
                <DayCard title="Mercoledì">
                  <SectionPricesInner
                    unico={ferWedUnico}
                    setUnico={setFerWedUnico}
                    unicoPrice={ferWedUnicoPrice}
                    setUnicoPrice={setFerWedUnicoPrice}
                    triple={ferWedTriple}
                    setTriple={setFerWedTriple}
                  />
                </DayCard>
                <DayCard title="Giovedì">
                  <SectionPricesInner
                    unico={ferThuUnico}
                    setUnico={setFerThuUnico}
                    unicoPrice={ferThuUnicoPrice}
                    setUnicoPrice={setFerThuUnicoPrice}
                    triple={ferThuTriple}
                    setTriple={setFerThuTriple}
                  />
                </DayCard>
              </div>
            </div>

            {/* Metadati prodotto */}
            <section className="border rounded-2xl p-4 space-y-2">
              <h4 className="font-medium">Dettagli prodotto</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-gray-600">Template suffix (opzionale)</label>
                  <input
                    type="text"
                    value={templateSuffix}
                    onChange={(e) => setTemplateSuffix(e.target.value)}
                    className="w-full rounded-xl border px-3 py-2"
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-600">Tag (separati da virgola)</label>
                  <input
                    type="text"
                    value={tags || ""}
                    onChange={(e) => setTags(e.target.value)}
                    className="w-full rounded-xl border px-3 py-2"
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-600">Immagine URL (opzionale)</label>
                  <input
                    type="url"
                    value={imageUrl || ""}
                    onChange={(e) => setImageUrl(e.target.value)}
                    className="w-full rounded-xl border px-3 py-2"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm text-gray-600">Descrizione (facoltativa)</label>
                <textarea
                  value={desc || ""}
                  onChange={(e) => setDesc(e.target.value)}
                  className="w-full h-20 rounded-xl border p-3"
                />
              </div>
            </section>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  disabled={!canRun || isRunning}
                  className="rounded-xl bg-black text-white px-3 py-2 disabled:opacity-50"
                  onClick={handleCreateBundles}
                >
                  {isRunning ? "In corso..." : "Crea posti + biglietti"}
                </button>
                {isRunning && (
                  <button
                    type="button"
                    onClick={() => setAborted(true)}
                    className="rounded-xl border px-3 py-2"
                  >
                    Stop
                  </button>
                )}
              </div>
              <div className="flex items-center gap-3">
                <label className="text-xs text-gray-600">Lotto</label>
                <input
                  type="number"
                  min={1}
                  value={batchSize}
                  onChange={(e) => setBatchSize(Math.max(1, parseInt(e.target.value || "25", 10)))}
                  className="w-20 rounded-xl border px-2 py-1"
                />
                <span className="text-xs text-gray-600">Stima posti/biglietti: {comboCount || 0}</span>
              </div>
            </div>

            {/* Avanzamento */}
            {(isRunning || progress.total > 0) && (
              <div className="mt-3">
                <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
                  <div>Avanzamento: {progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%</div>
                  <div>Batch {progress.batchIndex}/{progress.batchesTotal}</div>
                </div>
                <div className="h-2 bg-gray-200 rounded-xl overflow-hidden">
                  <div className="h-2 bg-black" style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
                </div>
                <div className="text-xs text-gray-600 mt-1">
                  Slots {progress.done}/{progress.total} — Creati: S:{aggCounts.seatsCreated} B:{aggCounts.bundlesCreated} V:{aggCounts.variantsCreated}
                </div>
                {logLines.length > 0 && (
                  <div className="mt-2 text-xs font-mono bg-gray-50 border rounded-xl p-2 max-h-40 overflow-auto">
                    {logLines.map((l, i) => <div key={i}>{l}</div>)}
                  </div>
                )}
              </div>
            )}

          </div>

          <div className="bg-white rounded-2xl shadow-sm border p-5">
            <h3 className="font-medium mb-2">Anteprima carrello</h3>
            <p className="text-sm">
              <b>Prodotto:</b>{" "}
              {bundleTitleBase && sampleDate && sampleTime
                ? `${bundleTitleBase} — ${sampleDate.split("-").reverse().join("/")} ${sampleTime}`
                : "(compila titolo, date e orari)"}
            </p>
            <p className="text-sm">
              <b>Variante:</b> {sampleVariant}
            </p>
          </div>
        </section>

        {/* Modale semplice */}
        {modalMsg && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-lg p-5 max-w-lg w-full space-y-3">
              <div className="text-sm whitespace-pre-wrap">{modalMsg}</div>
              <div className="text-right">
                <button
                  onClick={() => setModalMsg(null)}
                  className="rounded-xl border px-3 py-2"
                >
                  OK
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- UI Subcomponents ----------------------------- */

function DayCard({ title, children }: { title: string; children: any }) {
  return (
    <div className="border rounded-2xl p-4">
      <div className="font-medium mb-2">{title}</div>
      {children}
    </div>
  );
}

function SectionPricesInner({
  unico,
  setUnico,
  unicoPrice,
  setUnicoPrice,
  triple,
  setTriple,
}: {
  unico: boolean;
  setUnico: (v: boolean) => void;
  unicoPrice: number;
  setUnicoPrice: (v: number) => void;
  triple: Triple;
  setTriple: (v: Triple) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={unico} onChange={(e) => setUnico(e.target.checked)} /> Biglietto unico
      </label>
      {unico ? (
        <Num label="Prezzo (€)" value={unicoPrice} onChange={setUnicoPrice} />
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <Num label="Adulto (€)" value={triple?.adulto} onChange={(v) => setTriple({ ...triple, adulto: v })} />
          <Num label="Bambino (€)" value={triple?.bambino} onChange={(v) => setTriple({ ...triple, bambino: v })} />
          <Num label="Handicap (€)" value={triple?.handicap} onChange={(v) => setTriple({ ...triple, handicap: v })} />
        </div>
      )}
    </div>
  );
}

function Num({ label, value, onChange }: { label: string; value?: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="text-sm text-gray-600">{label}</label>
      <input
        type="number"
        step="0.01"
        value={value ?? 0}
        onChange={(e) => onChange(parseFloat(e.target.value || "0"))}
        className="w-full rounded-xl border px-3 py-2"
      />
    </div>
  );
}

/* ----------------------------- State aggiuntivi per metadati ----------------------------- */
let templateSuffix = "";
let tags: string | undefined = undefined;
let imageUrl: string | undefined = undefined;
let desc: string | undefined = undefined;
let modalMsg: string | null = null;

function setTemplateSuffix(v: string) { templateSuffix = v; }
function setTags(v: string) { tags = v; }
function setImageUrl(v: string) { imageUrl = v; }
function setDesc(v: string) { desc = v; }
function setModalMsg(v: string | null) { modalMsg = v; }

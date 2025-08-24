"use client";
import { useMemo, useState, useEffect, useRef } from "react";

/**
 * Admin Generator — UI v3 (batching + backoff + progress)
 * - Persistenza Admin Secret in localStorage
 * - Integrazione con /api/admin/generate-bundles (source:"manual")
 * - Batching per date contigue con limite eventi/slot per batch
 * - Retry/backoff su 429/5xx (+ Retry-After se presente)
 * - Barra di avanzamento e log compatto
 */
const LS_ADMIN_SECRET = "sinflora_admin_secret";

// ---- Batching/Retry config (puoi regolare senza ricompilare logiche server) ----
const MAX_EVENTS_PER_BATCH = 25; // circa "slot" per chiamata (date * numero di orari)
const MAX_RETRIES = 6; // tentativi per batch
const BASE_BACKOFF_MS = 700; // backoff iniziale (poi esponenziale con jitter)

/* ----------------------------- Tipi locali (frontend) ----------------------------- */
type Triple = { adulto?: number; bambino?: number; handicap?: number };
type PriceTierEuro = {
  unico?: number;
  adulto?: number;
  bambino?: number;
  handicap?: number;
};
type PricesEuro = {
  holiday?: PriceTierEuro;
  saturday?: PriceTierEuro;
  sunday?: PriceTierEuro;
  friday?: PriceTierEuro;
  feriali?: PriceTierEuro & {
    perDay?: {
      mon?: PriceTierEuro;
      tue?: PriceTierEuro;
      wed?: PriceTierEuro;
      thu?: PriceTierEuro;
    };
  };
};
type GenerateBundlesResponse = {
  ok: boolean;
  error?: string;
  detail?: string;
  summary?: {
    seatsCreated: number;
    bundlesCreated: number;
    variantsCreated: number;
    inventoryAdjusted?: number;
    relationshipsUpserted?: number;
    pricesUpdated?: number;
  };
  warnings?: string[];
  preview?: any[];
};

/* ----------------------------- Helpers data ----------------------------- */
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isNextDay(a: string, b: string): boolean {
  return addDays(a, 1) === b;
}
function chunkContiguousDates(
  dates: string[],
  maxPerBatchByDay: number
): Array<{ start: string; end: string; days: string[] }> {
  if (!dates.length) return [];
  // 1) raggruppa in blocchi CONTIGUI (senza buchi)
  const groups: string[][] = [];
  let current: string[] = [dates[0]];
  for (let i = 1; i < dates.length; i++) {
    const prev = dates[i - 1];
    const cur = dates[i];
    if (isNextDay(prev, cur)) current.push(cur);
    else {
      groups.push(current);
      current = [cur];
    }
  }
  groups.push(current);
  // 2) splitta ulteriormente ogni gruppo in sottogruppi di dimensione maxPerBatchByDay
  const out: Array<{ start: string; end: string; days: string[] }> = [];
  for (const g of groups) {
    for (let i = 0; i < g.length; i += maxPerBatchByDay) {
      const sub = g.slice(i, i + maxPerBatchByDay);
      out.push({ start: sub[0], end: sub[sub.length - 1], days: sub });
    }
  }
  return out;
}

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
  const [bundleTitleBase, setBundleTitleBase] = useState(""); // Biglietti (visibili) — (UI only preview)
  const [dryRun, setDryRun] = useState(true);
  const [fridayAsWeekend, setFridayAsWeekend] = useState(false);

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

  // Feriali — modalità generale o per-giorno (Lun–Gio)
  const [ferSeparate, setFerSeparate] = useState(false);
  const [ferUnico, setFerUnico] = useState(false); // generale
  const [ferUnicoPrice, setFerUnicoPrice] = useState<number>(0);
  const [ferTriple, setFerTriple] = useState<Triple>({}); // generale
  // Per-giorno: Lun(1) Mar(2) Mer(3) Gio(4)
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

  // Dettagli prodotto
  const [templateSuffix, setTemplateSuffix] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [desc, setDesc] = useState("");
  const [tags, setTags] = useState("");

  // Stato batching/progresso
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const [batchLabel, setBatchLabel] = useState("");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [aggSeats, setAggSeats] = useState(0);
  const [aggBundles, setAggBundles] = useState(0);
  const [aggVariants, setAggVariants] = useState(0);
  const abortRef = useRef<{ aborted: boolean }>({ aborted: false });

  // Modale feedback
  const [modalMsg, setModalMsg] = useState<string | null>(null);

  // -----------------------------
  // Persistenza Admin Secret
  // -----------------------------
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

  // -----------------------------
  // Helpers date/orari
  // -----------------------------
  function listDatesBetween(start: string, end: string): string[] {
    if (!start || !end) return [];
    const out: string[] = [];
    const s = new Date(start + "T12:00:00+01:00");
    const e = new Date(end + "T12:00:00+01:00");
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      out.push(`${y}-${m}-${day}`);
    }
    return out;
  }
  function getDowRome(dateStr: string): number {
    const d = new Date(dateStr + "T12:00:00+01:00"); // 0=Dom .. 6=Sab
    return d.getDay();
  }
  // Validazione orari HH:MM (24h)
  const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
  function isValidHHMM(s: string) {
    return HHMM.test(s);
  }
  function sortHHMM(arr: string[]): string[] {
    return [...arr].sort((a, b) => {
      const [ah, am] = a.split(":").map(Number);
      const [bh, bm] = b.split(":").map(Number);
      return ah * 60 + am - (bh * 60 + bm);
    });
  }
  function parseTimesWithValidation(
    txt: string
  ): { valid: string[]; invalid: string[]; duplicatesRemoved: number } {
    const raw = txt
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const t of raw) {
      if (!seen.has(t)) {
        seen.add(t);
        deduped.push(t);
      }
    }
    const invalid: string[] = [];
    const valid: string[] = [];
    for (const t of deduped) {
      if (isValidHHMM(t)) valid.push(t);
      else invalid.push(t);
    }
    const sortedValid = sortHHMM(valid);
    return { valid: sortedValid, invalid, duplicatesRemoved: raw.length - deduped.length };
  }

  // Calcoli memoizzati
  const allDates = useMemo(() => listDatesBetween(dateStart, dateEnd), [dateStart, dateEnd]);
  const excludedSet = useMemo(() => new Set(excluded), [excluded]);
  const effectiveDates = useMemo(
    () => allDates.filter((d) => !excludedSet.has(d)),
    [allDates, excludedSet]
  );
  const timesInfo = useMemo(() => parseTimesWithValidation(timesText), [timesText]);

  const canRunBase =
    productTitleBase.trim() &&
    bundleTitleBase.trim() &&
    effectiveDates.length > 0 &&
    timesInfo.valid.length > 0 &&
    capacityPerSlot > 0;

  const canRun = Boolean(
    canRunBase && timesInfo.invalid.length === 0 && adminSecret.trim().length > 0 && !isRunning
  );

  const comboCount = useMemo(
    () => effectiveDates.length * timesInfo.valid.length,
    [effectiveDates.length, timesInfo.valid.length]
  );

  // Sample carrello
  const sampleDate = effectiveDates[0] || "";
  const sampleTime = timesInfo.valid[0] || "";
  function isUnicoForSample(dateStr: string): boolean {
    if (!dateStr) return false;
    const dow = getDowRome(dateStr);
    if (dow === 6) return satUnico; // sab
    if (dow === 0) return sunUnico; // dom
    if (dow === 5) return fridayAsWeekend ? satUnico : friUnico; // ven
    if (dow >= 1 && dow <= 4) {
      if (ferSeparate) {
        if (dow === 1) return ferMonUnico;
        if (dow === 2) return ferTueUnico;
        if (dow === 3) return ferWedUnico;
        if (dow === 4) return ferThuUnico;
      }
      return ferUnico; // generale Lun–Gio
    }
    return false;
  }
  const sampleTitle =
    bundleTitleBase && sampleDate && sampleTime
      ? `${bundleTitleBase} — ${sampleDate.split("-").reverse().join("/")} ${sampleTime}`
      : "(compila titolo, date e orari)";
  const sampleVariant = isUnicoForSample(sampleDate)
    ? "Biglietto unico"
    : "Adulto / Bambino / Handicap";

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
    if (!fridayAsWeekend) {
      const fri = toTier(friUnico, friUnicoPrice, friTriple);
      if (fri) prices.friday = fri;
    }
    if (!ferSeparate) {
      const fer = toTier(ferUnico, ferUnicoPrice, ferTriple);
      if (fer) prices.feriali = fer as any;
    } else {
      // per-day: lun-mar-mer-gio
      const perDay: NonNullable<NonNullable<PricesEuro["feriali"]>["perDay"]> = {};
      const mon = toTier(ferMonUnico, ferMonUnicoPrice, ferMonTriple);
      const tue = toTier(ferTueUnico, ferTueUnicoPrice, ferTueTriple);
      const wed = toTier(ferWedUnico, ferWedUnicoPrice, ferWedTriple);
      const thu = toTier(ferThuUnico, ferThuUnicoPrice, ferThuTriple);
      if (mon) perDay.mon = mon;
      if (tue) perDay.tue = tue;
      if (wed) perDay.wed = wed;
      if (thu) perDay.thu = thu;
      if (Object.keys(perDay).length) {
        prices.feriali = { ...(prices.feriali || {}), perDay };
      }
    }
    return prices;
  }

  // Slots separati per weekday/weekend (al momento sono identici; lasciamo l'API pronta per differenziarli)
  const weekdaySlots = useMemo(() => {
    return timesInfo.valid;
  }, [timesInfo.valid]);
  const weekendSlots = useMemo(() => {
    return timesInfo.valid;
  }, [timesInfo.valid]);

  /* ----------------------------- Retry helper (client) ----------------------------- */
  async function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function pickBackoff(attempt: number, retryAfterSec?: number | null) {
    if (retryAfterSec && Number.isFinite(retryAfterSec)) return retryAfterSec * 1000;
    const jitter = Math.random() * 250; // 0-250ms
    return Math.min(10000, BASE_BACKOFF_MS * Math.pow(2, attempt - 1)) + jitter;
  }
  function parseRetryAfter(h: Headers): number | null {
    const ra = h.get("Retry-After");
    if (!ra) return null;
    const sec = parseFloat(ra);
    return Number.isFinite(sec) ? sec : null;
  }
  async function postWithRetry(body: any, attempt = 1): Promise<Response> {
    const res = await fetch("/api/admin/generate-bundles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-secret": adminSecret || "",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;
    // Solo retry su 429 e 5xx
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const ra = parseRetryAfter(res.headers);
      const delay = pickBackoff(attempt, ra);
      setLogLines((prev) => [
        ...prev.slice(-100),
        `⚠️ Batch retry ${attempt}/${MAX_RETRIES - 1} tra ${(delay / 1000).toFixed(1)}s (HTTP ${res.status})`,
      ]);
      await sleep(delay);
      return postWithRetry(body, attempt + 1);
    }
    return res; // consegniamo errore al chiamante
  }

  // -----------------------------
  // Call API generate-bundles (manual) — con batching
  // -----------------------------
  async function handleCreateBundles() {
    if (!canRun) return;
    // reset stato
    abortRef.current.aborted = false;
    setIsRunning(true);
    setProgress(0);
    setBatchLabel("");
    setAggSeats(0);
    setAggBundles(0);
    setAggVariants(0);
    setLogLines([]);
    try {
      const prices = buildPrices();
      // Prepara tag puliti
      const cleanTags = tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
      // Calcolo batching: numero di giorni per batch in base agli slot per giorno
      const perDaySlots = timesInfo.valid.length;
      const daysPerBatch = Math.max(1, Math.floor(MAX_EVENTS_PER_BATCH / Math.max(1, perDaySlots)));
      // Raggruppa date effettive in range CONTIGUI e poi chunk in sottorange di daysPerBatch
      const contiguous = chunkContiguousDates(effectiveDates, daysPerBatch);
      const totalBatches = contiguous.length;
      if (totalBatches === 0) {
        setIsRunning(false);
        return;
      }
      setLogLines((prev) => [
        ...prev,
        `▶️ Avvio creazione ${dryRun ? "(dry-run)" : ""}: ${effectiveDates.length} giorni × ${perDaySlots} orari = ${comboCount} slot totali, in ${totalBatches} batch`,
      ]);

      for (let i = 0; i < contiguous.length; i++) {
        if (abortRef.current.aborted) throw new Error("Operazione annullata");
        const b = contiguous[i];
        setBatchLabel(`Batch ${i + 1}/${totalBatches} • ${b.start} → ${b.end}`);
        setLogLines((prev) => [
          ...prev.slice(-100),
          `🟩 Batch ${i + 1}/${totalBatches}: ${b.days.length} giorni`,
        ]);

        const body = {
          source: "manual",
          dryRun,
          eventHandle: productTitleBase,
          startDate: b.start,
          endDate: b.end,
          weekdaySlots,
          weekendSlots,
          "prices€": prices,
          fridayAsWeekend,
          capacityPerSlot,
          templateSuffix: templateSuffix || undefined,
          imageUrl: imageUrl || undefined,
          description: desc || undefined,
          tags: cleanTags,
        };

        const res = await postWithRetry(body);

        let data: GenerateBundlesResponse | null = null;
        try {
          data = (await res.json()) as GenerateBundlesResponse;
        } catch {
          /* non-JSON */
        }

        if (!res.ok || !data?.ok) {
          const errCode = data?.error || `${res.status}`;
          const errDetail = data?.detail || res.statusText || "Errore sconosciuto";
          setLogLines((prev) => [
            ...prev.slice(-100),
            `❌ Errore batch ${i + 1}/${totalBatches}: ${errCode} — ${errDetail}`,
          ]);
          throw new Error(`Errore Bundles: ${errCode} — ${errDetail}`);
        }

        const s = data.summary || { seatsCreated: 0, bundlesCreated: 0, variantsCreated: 0 };
        setAggSeats((v) => v + (s.seatsCreated || 0));
        setAggBundles((v) => v + (s.bundlesCreated || 0));
        setAggVariants((v) => v + (s.variantsCreated || 0));
        setLogLines((prev) => [
          ...prev.slice(-100),
          `✅ Ok batch ${i + 1}/${totalBatches} — seats:${s.seatsCreated || 0}, bundles:${s.bundlesCreated || 0}, variants:${s.variantsCreated || 0}`,
        ]);
        setProgress((i + 1) / totalBatches);
      }

      setModalMsg(
        `OK — ${dryRun ? "anteprima (dry-run)" : "creazione"} completata\nPosti creati: ${
          aggSeats + 0
        }\nBiglietti creati: ${aggBundles + 0}\nVarianti create: ${aggVariants + 0}`
      );
    } catch (err: any) {
      console.error("Errore Bundles:", err);
      setModalMsg(String(err?.message || err));
    } finally {
      setIsRunning(false);
      setBatchLabel("");
    }
  }

  // -----------------------------
  // TEST automatici (console) per parser orari
  // -----------------------------
  useEffect(() => {
    const ok = (name: string, cond: boolean) => console.assert(cond, `Test fallito: ${name}`);
    const t1 = parseTimesWithValidation("");
    ok("vuoto", t1.valid.length === 0 && t1.invalid.length === 0);
    const t2 = parseTimesWithValidation("10:00\n11:30\n11:30\n25:99\n");
    ok("dup e invalid", t2.valid.join(",") === "10:00,11:30" && t2.invalid[0] === "25:99");
    const t3 = parseTimesWithValidation("11:30\n09:00\n");
    ok("ordinamento", t3.valid.join(",") === "09:00,11:30");
    const t4 = parseTimesWithValidation("00:00\n23:59");
    ok("bordi", t4.valid.join(",") === "00:00,23:59");
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Sinflora — Admin Generator (UI v3)</h1>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={adminSecret}
              onChange={(e) => setAdminSecret(e.target.value)}
              className="rounded-xl border px-3 py-2 w-64"
              placeholder="Admin secret"
              disabled={isRunning}
            />
            <label className="text-sm inline-flex items-center gap-2">
              <input
                className="size-4"
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
                disabled={isRunning}
              />
              Dry-run
            </label>
          </div>
        </header>

        <section className="grid lg:grid-cols-2 gap-6">
          {/* Colonna SX */}
          <div className="bg-white rounded-2xl shadow-sm border p-5 space-y-4">
            <h3 className="font-medium">🪑 Posti (nascosti)</h3>

            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-600">Data inizio</label>
                <input
                  type="date"
                  value={dateStart}
                  onChange={(e) => setDateStart(e.target.value)}
                  className="w-full mt-1 rounded-xl border px-3 py-2"
                  disabled={isRunning}
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">Data fine</label>
                <input
                  type="date"
                  value={dateEnd}
                  onChange={(e) => setDateEnd(e.target.value)}
                  className="w-full mt-1 rounded-xl border px-3 py-2"
                  disabled={isRunning}
                />
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
                      className={`rounded-lg border px-2 py-1 text-sm ${
                        isEx
                          ? "bg-red-50 border-red-300 text-red-700"
                          : "bg-white border-gray-300 text-gray-700"
                      }`}
                      disabled={isRunning}
                    >
                      {d.slice(5)}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="text-sm text-gray-600">Orari (uno per riga)</label>
              <textarea
                rows={3}
                value={timesText}
                onChange={(e) => setTimesText(e.target.value)}
                className={`w-full mt-1 rounded-xl border px-3 py-2 ${
                  timesInfo.invalid.length ? "border-red-400" : ""
                }`}
                placeholder={"10:00\n10:30\n11:00"}
                disabled={isRunning}
              />
              {timesInfo.invalid.length > 0 && (
                <p className="text-xs text-red-600 mt-1">
                  Orari non validi: {timesInfo.invalid.join(", ")}. Correggi per procedere.
                </p>
              )}
              {timesInfo.duplicatesRemoved > 0 && (
                <p className="text-xs text-gray-500 mt-1">
                  Duplicati rimossi automaticamente: {timesInfo.duplicatesRemoved}
                </p>
              )}
            </div>

            <div>
              <label className="text-sm text-gray-600">Nome base posti</label>
              <input
                value={productTitleBase}
                onChange={(e) => setProductTitleBase(e.target.value)}
                className="w-full mt-1 rounded-xl border px-3 py-2"
                disabled={isRunning}
              />
            </div>

            <div>
              <label className="text-sm text-gray-600">Capienza per slot</label>
              <input
                type="number"
                value={capacityPerSlot}
                onChange={(e) => setCapacityPerSlot(parseInt(e.target.value || "0", 10))}
                className="w-full mt-1 rounded-xl border px-3 py-2"
                disabled={isRunning}
              />
            </div>

            <div className="flex items-center justify-between">
              <button
                disabled={!canRun}
                className="rounded-xl bg-black text-white px-3 py-2 disabled:opacity-50"
                onClick={handleCreateBundles}
              >
                {isRunning ? "In corso…" : "Crea posti + biglietti"}
              </button>
              <span className="text-xs text-gray-600">Stima posti/biglietti: {comboCount || 0}</span>
            </div>
          </div>

          {/* Colonna DX */}
          <div className="bg-white rounded-2xl shadow-sm border p-5 space-y-4">
            <h3 className="font-medium">🎟️ Biglietti (visibili)</h3>

            <div>
              <label className="text-sm text-gray-600">Nome base biglietti</label>
              <input
                value={bundleTitleBase}
                onChange={(e) => setBundleTitleBase(e.target.value)}
                className="w-full mt-1 rounded-xl border px-3 py-2"
                disabled={isRunning}
              />
            </div>

            {/* Festivi */}
            <SectionPrices
              title="Festivi"
              unico={holidayUnico}
              setUnico={setHolidayUnico}
              unicoPrice={holidayUnicoPrice}
              setUnicoPrice={setHolidayUnicoPrice}
              triple={holidayTriple}
              setTriple={setHolidayTriple}
            />
            {/* Sabato */}
            <SectionPrices
  title="Sabato"
  unico={satUnico}
  setUnico={setSatUnico}
  unicoPrice={satUnicoPrice}
  setUnicoPrice={setSatUnicoPrice}
  triple={satTriple}
  setTriple={setSatTriple}
/>

            {/* Domenica */}
            <SectionPrices
              title="Domenica"
              unico={sunUnico}
              setUnico={setSunUnico}
              unicoPrice={sunUnicoPrice}
              setUnicoPrice={setSunUnicoPrice}
              triple={sunTriple}
              setTriple={setSunTriple}
            />

            {/* Venerdì */}
            <section className="border rounded-2xl p-4 space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="font-medium">Venerdì</h4>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={fridayAsWeekend}
                    onChange={(e) => setFridayAsWeekend(e.target.checked)}
                    disabled={isRunning}
                  />
                  Usa prezzi weekend (come Sabato)
                </label>
              </div>
              {!fridayAsWeekend && (
                <SectionPricesInner
                  unico={friUnico}
                  setUnico={setFriUnico}
                  unicoPrice={friUnicoPrice}
                  setUnicoPrice={setFriUnicoPrice}
                  triple={friTriple}
                  setTriple={setFriTriple}
                />
              )}
            </section>

            {/* Feriali (Lun–Gio) */}
            <section className="border rounded-2xl p-4 space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="font-medium">Feriali (Lun–Gio)</h4>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={ferSeparate}
                    onChange={(e) => setFerSeparate(e.target.checked)}
                    disabled={isRunning}
                  />
                  Prezzi separati per giorno
                </label>
              </div>
              {!ferSeparate ? (
                <SectionPricesInner
                  unico={ferUnico}
                  setUnico={setFerUnico}
                  unicoPrice={ferUnicoPrice}
                  setUnicoPrice={setFerUnicoPrice}
                  triple={ferTriple}
                  setTriple={setFerTriple}
                />
              ) : (
                <div className="grid md:grid-cols-2 gap-3">
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
              )}
            </section>

            {/* Metadati prodotto */}
            <section className="border rounded-2xl p-4 space-y-2">
              <h4 className="font-medium">Dettagli prodotto</h4>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-sm text-gray-600">Template suffix</label>
                  <input
                    value={templateSuffix}
                    onChange={(e) => setTemplateSuffix(e.target.value)}
                    className="w-full mt-1 rounded-xl border px-3 py-2"
                    placeholder="es. bundle"
                    disabled={isRunning}
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-600">Immagine (URL)</label>
                  <input
                    value={imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                    className="w-full mt-1 rounded-xl border px-3 py-2"
                    placeholder="https://…"
                    disabled={isRunning}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-sm text-gray-600">Descrizione</label>
                  <textarea
                    rows={4}
                    value={desc}
                    onChange={(e) => setDesc(e.target.value)}
                    className="w-full mt-1 rounded-xl border px-3 py-2"
                    placeholder="Testo descrizione…"
                    disabled={isRunning}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-sm text-gray-600">Tag (separati da virgola)</label>
                  <input
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    className="w-full mt-1 rounded-xl border px-3 py-2"
                    disabled={isRunning}
                  />
                </div>
              </div>
            </section>

            <div className="flex items-center justify-between">
              <button
                disabled={!canRun}
                className="rounded-xl bg-black text-white px-3 py-2 disabled:opacity-50"
                onClick={handleCreateBundles}
              >
                {isRunning ? "In corso…" : "Crea biglietti"}
              </button>
              <span className="text-xs text-gray-600">Stima biglietti: {comboCount || 0}</span>
            </div>
          </div>
        </section>

        {/* Progresso & Log */}
        <section className="grid lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-2xl shadow-sm border p-5 space-y-3">
            <h3 className="font-medium mb-1">Stato lavorazione</h3>
            <div className="h-2 w-full bg-gray-200 rounded-full overflow-hidden">
              <div className="h-full bg-black" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <div className="flex items-center justify-between text-sm text-gray-600">
              <span>{batchLabel || "In attesa"}</span>
              <span>{Math.round(progress * 100)}%</span>
            </div>
            <div className="text-xs text-gray-700">
              Totale finora — Posti: <b>{aggSeats}</b> • Biglietti: <b>{aggBundles}</b> • Varianti:{" "}
              <b>{aggVariants}</b>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border p-5">
            <h3 className="font-medium mb-2">Log</h3>
            <div className="max-h-48 overflow-auto text-xs whitespace-pre-wrap leading-5">
              {logLines.length ? (
                logLines.map((l, i) => <div key={i}>• {l}</div>)
              ) : (
                <div className="text-gray-500">(vuoto)</div>
              )}
            </div>
          </div>
        </section>

        {/* Output sintetico */}
        <section className="grid lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-2xl shadow-sm border p-5">
            <h3 className="font-medium mb-2">Stima risultati</h3>
            <p className="text-sm">
              Posti: <b>{comboCount || 0}</b> • Biglietti: <b>{comboCount || 0}</b>
            </p>
            {timesInfo.valid.length > 0 && (
              <p className="text-xs text-gray-600 mt-1">
                Orari validi (ordinati): {timesInfo.valid.join(", ")}
              </p>
            )}
          </div>
          <div className="bg-white rounded-2xl shadow-sm border p-5">
            <h3 className="font-medium mb-2">Anteprima carrello</h3>
            <p className="text-sm">
              <b>Prodotto:</b> {sampleTitle}
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
                <button onClick={() => setModalMsg(null)} className="rounded-xl border px-3 py-2">
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

/* ----------------------------- Sotto-componenti ----------------------------- */
function SectionPrices({
  title,
  unico,
  setUnico,
  unicoPrice,
  setUnicoPrice,
  triple,
  setTriple,
}: {
  title: string;
  unico: boolean;
  setUnico: (v: boolean) => void;
  unicoPrice: number;
  setUnicoPrice: (v: number) => void;
  triple: { adulto?: number; bambino?: number; handicap?: number };
  setTriple: (t: { adulto?: number; bambino?: number; handicap?: number }) => void;
}) {
  return (
    <section className="border rounded-2xl p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="font-medium">{title}</h4>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={unico} onChange={(e) => setUnico(e.target.checked)} />
          Biglietto unico
        </label>
      </div>
      {unico ? (
        <input
          type="number"
          step="0.01"
          value={unicoPrice}
          onChange={(e) => setUnicoPrice(parseFloat(e.target.value || "0"))}
          className="w-full rounded-xl border px-3 py-2"
          placeholder="€"
        />
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <Num label="Adulto (€)" value={triple.adulto} onChange={(v) => setTriple({ ...triple, adulto: v })} />
          <Num label="Bambino (€)" value={triple.bambino} onChange={(v) => setTriple({ ...triple, bambino: v })} />
          <Num label="Handicap (€)" value={triple.handicap} onChange={(v) => setTriple({ ...triple, handicap: v })} />
        </div>
      )}
    </section>
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
  triple: { adulto?: number; bambino?: number; handicap?: number };
  setTriple: (t: { adulto?: number; bambino?: number; handicap?: number }) => void;
}) {
  return (
    <>
      <label className="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={unico} onChange={(e) => setUnico(e.target.checked)} />
        Biglietto unico
      </label>
      {unico ? (
        <input
          type="number"
          step="0.01"
          value={unicoPrice}
          onChange={(e) => setUnicoPrice(parseFloat(e.target.value || "0"))}
          className="w-full rounded-xl border px-3 py-2"
          placeholder="€"
        />
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <Num label="Adulto (€)" value={triple.adulto} onChange={(v) => setTriple({ ...triple, adulto: v })} />
          <Num label="Bambino (€)" value={triple.bambino} onChange={(v) => setTriple({ ...triple, bambino: v })} />
          <Num label="Handicap (€)" value={triple.handicap} onChange={(v) => setTriple({ ...triple, handicap: v })} />
        </div>
      )}
    </>
  );
}

function DayCard({ title, children }: { title: string; children: any }) {
  return (
    <div className="rounded-xl border p-3">
      <div className="text-sm font-medium mb-1">{title}</div>
      {children}
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

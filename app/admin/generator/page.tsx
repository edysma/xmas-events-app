"use client";

import { useMemo, useState, useEffect } from "react";

/**
 * Pagina Admin Generator (UI v2) con:
 * - Admin Secret persistito in localStorage
 * - Pulsanti “Crea posti” e “Crea biglietti” che chiamano le API
 * - Body payload in modalità "manual" con "source":"manual"
 * - Gestione prezzi (unico / triple) incluse le opzioni feriali per-giorno
 * - Tipi locali per evitare errori TS con la chiave "perDay"
 */

const LS_ADMIN_SECRET = "sinflora_admin_secret";

/* ---------------- Tipi locali (solo per la UI) ---------------- */

type PriceTierEuroLocal = {
  unico?: number;
  adulto?: number;
  bambino?: number;
  handicap?: number;
};

type FerialiTierLocal = PriceTierEuroLocal & {
  perDay?: {
    mon?: PriceTierEuroLocal;
    tue?: PriceTierEuroLocal;
    wed?: PriceTierEuroLocal;
    thu?: PriceTierEuroLocal;
  };
};

type PricesEuroLocal = {
  holiday?: PriceTierEuroLocal;
  saturday?: PriceTierEuroLocal;
  sunday?: PriceTierEuroLocal;
  friday?: PriceTierEuroLocal;
  feriali?: FerialiTierLocal;
};

export default function AdminGeneratorUIV2() {
  // -----------------------------
  // Stato principale
  // -----------------------------
  const [adminSecret, setAdminSecret] = useState(""); // Admin Secret (persistente)

  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [timesText, setTimesText] = useState("");

  const [productTitleBase, setProductTitleBase] = useState(""); // Posti (nascosti)
  const [capacityPerSlot, setCapacityPerSlot] = useState<number>(0);

  const [bundleTitleBase, setBundleTitleBase] = useState(""); // Biglietti (visibili)
  const [dryRun, setDryRun] = useState(true);
  const [fridayAsWeekend, setFridayAsWeekend] = useState(false);

  // Prezzi — toggle "unico" + tripla (Adulto/Bambino/Handicap)
  type Triple = { adulto?: number; bambino?: number; handicap?: number };

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
    const d = new Date(dateStr + "T12:00:00+01:00");
    // 0=Dom .. 6=Sab
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
  function parseTimesWithValidation(txt: string): { valid: string[]; invalid: string[]; duplicatesRemoved: number } {
    const raw = txt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
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
  const effectiveDates = useMemo(() => allDates.filter((d) => !excludedSet.has(d)), [allDates, excludedSet]);
  const timesInfo = useMemo(() => parseTimesWithValidation(timesText), [timesText]);

  const canRunBase =
    productTitleBase.trim() &&
    bundleTitleBase.trim() &&
    effectiveDates.length > 0 &&
    timesInfo.valid.length > 0 &&
    capacityPerSlot > 0;
  const canRun = Boolean(canRunBase && timesInfo.invalid.length === 0);

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
  const sampleVariant = isUnicoForSample(sampleDate) ? "Biglietto unico" : "Adulto / Bambino / Handicap";

  // UI: toggle esclusione date
  function toggleExclude(d: string) {
    setExcluded((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
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

  /* ---------------- API helpers ---------------- */

  function toTier(unico: boolean, unicoPrice: number, triple: Triple): PriceTierEuroLocal | undefined {
    if (unico) {
      if (Number.isFinite(unicoPrice) && unicoPrice > 0) return { unico: Number(unicoPrice) };
      return undefined;
    }
    const t: PriceTierEuroLocal = {};
    if (Number.isFinite(triple.adulto as number) && (triple.adulto as number) > 0) t.adulto = Number(triple.adulto);
    if (Number.isFinite(triple.bambino as number) && (triple.bambino as number) > 0) t.bambino = Number(triple.bambino);
    if (Number.isFinite(triple.handicap as number) && (triple.handicap as number) > 0) t.handicap = Number(triple.handicap);
    if (Object.keys(t).length === 0) return undefined;
    return t;
  }

  function buildPricesPayload(): PricesEuroLocal {
    const prices: PricesEuroLocal = {};

    // Festivi / Sabato / Domenica / Venerdì
    const holiday = toTier(holidayUnico, holidayUnicoPrice, holidayTriple);
    if (holiday) prices.holiday = holiday;

    const saturday = toTier(satUnico, satUnicoPrice, satTriple);
    if (saturday) prices.saturday = saturday;

    const sunday = toTier(sunUnico, sunUnicoPrice, sunTriple);
    if (sunday) prices.sunday = sunday;

    const friday = fridayAsWeekend ? (saturday || sunday || holiday) : toTier(friUnico, friUnicoPrice, friTriple);
    if (friday) prices.friday = friday;

    // Feriali
    if (!ferSeparate) {
      const fer: PriceTierEuroLocal = toTier(ferUnico, ferUnicoPrice, ferTriple) || {};
      if (Object.keys(fer).length) prices.feriali = fer as FerialiTierLocal;
    } else {
      const perDay: FerialiTierLocal["perDay"] = {};
      const mon = toTier(ferMonUnico, ferMonUnicoPrice, ferMonTriple);
      const tue = toTier(ferTueUnico, ferTueUnicoPrice, ferTueTriple);
      const wed = toTier(ferWedUnico, ferWedUnicoPrice, ferWedTriple);
      const thu = toTier(ferThuUnico, ferThuUnicoPrice, ferThuTriple);
      if (mon) perDay!.mon = mon;
      if (tue) perDay!.tue = tue;
      if (wed) perDay!.wed = wed;
      if (thu) perDay!.thu = thu;
      if (Object.keys(perDay!).length) prices.feriali = { perDay } as FerialiTierLocal;
    }

    return prices;
  }

  async function callApiGenerateBundles() {
    // costruisci slots
    const all = timesInfo.valid;
    const excludedSetLocal = new Set(excluded);
    const dates = allDates.filter((d) => !excludedSetLocal.has(d));

    // Weekday/Weekend split per coerenza con la route
    const weekdaySlots: string[] = [];
    const weekendSlots: string[] = [];
    // Nella UI passiamo sempre tutti gli orari in entrambe le liste: decide la API quale usare per ogni giorno
    weekdaySlots.push(...all);
    weekendSlots.push(...all);

    const prices = buildPricesPayload();

    const payload = {
      source: "manual" as const,
      dryRun,
      eventHandle: bundleTitleBase.trim(),
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      weekdaySlots,
      weekendSlots,
      fridayAsWeekend,
      "prices€": prices,
      exceptionsByDate: {}, // opzionale
      capacityPerSlot,
      templateSuffix: templateSuffix || undefined,
      description: desc || undefined,
      imageUrl: imageUrl || undefined,
      tags: (tags || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    };

    const res = await fetch("/api/admin/generate-bundles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-secret": adminSecret || "",
      },
      body: JSON.stringify(payload),
    });

    let out: any = null;
    try {
      out = await res.json();
    } catch {
      console.error("Bundles: risposta non JSON");
    }
    console.log("Bundles result:", out || { status: res.status, statusText: res.statusText });
    if (!res.ok) {
      alert(`Errore Bundles: ${out?.error || res.status} — ${out?.detail || res.statusText}`);
    } else {
      alert(`OK Bundles — created: ${(out?.summary && JSON.stringify(out.summary)) || "preview"}`);
    }
  }

  async function callApiGenerateSeats() {
    // Per coerenza con il flusso attuale, usiamo la stessa route /generate-bundles (manual)
    // perché in backend la creazione dei Seat è parte dello stesso giro di creazione.
    await callApiGenerateBundles();
  }

  // -----------------------------
  // Render
  // -----------------------------
  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Sinflora — Admin Generator (UI v2)</h1>
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

        <section className="grid lg:grid-cols-2 gap-6">
          {/* Colonna SX */}
          <div className="bg-white rounded-2xl shadow-sm border p-5 space-y-4">
            <h3 className="font-medium">🪑 Posti (nascosti)</h3>
            <div className="grid sm:grid-cols-2 gap-3">
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
                      className={`rounded-lg border px-2 py-1 text-sm ${isEx ? "bg-red-50 border-red-300 text-red-700" : "bg-white border-gray-300 text-gray-700"}`}
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
                className={`w-full mt-1 rounded-xl border px-3 py-2 ${timesInfo.invalid.length ? "border-red-400" : ""}`}
                placeholder={"10:00\n10:30\n11:00"}
              />
              {timesInfo.invalid.length > 0 && (
                <p className="text-xs text-red-600 mt-1">Orari non validi: {timesInfo.invalid.join(", ")}. Correggi per procedere.</p>
              )}
              {timesInfo.duplicatesRemoved > 0 && (
                <p className="text-xs text-gray-500 mt-1">Duplicati rimossi automaticamente: {timesInfo.duplicatesRemoved}</p>
              )}
            </div>

            <div>
              <label className="text-sm text-gray-600">Nome base posti</label>
              <input value={productTitleBase} onChange={(e) => setProductTitleBase(e.target.value)} className="w-full mt-1 rounded-xl border px-3 py-2" />
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

            <div className="flex items-center justify-between">
              <button
                disabled={!canRun}
                className="rounded-xl bg-black text-white px-3 py-2 disabled:opacity-50"
                onClick={callApiGenerateSeats}
              >
                Crea posti
              </button>
              <span className="text-xs text-gray-600">Stima posti: {comboCount || 0}</span>
            </div>
          </div>

          {/* Colonna DX */}
          <div className="bg-white rounded-2xl shadow-sm border p-5 space-y-4">
            <h3 className="font-medium">🎟️ Biglietti (visibili)</h3>
            <div>
              <label className="text-sm text-gray-600">Nome base biglietti</label>
              <input value={bundleTitleBase} onChange={(e) => setBundleTitleBase(e.target.value)} className="w-full mt-1 rounded-xl border px-3 py-2" />
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
                  <input type="checkbox" checked={fridayAsWeekend} onChange={(e) => setFridayAsWeekend(e.target.checked)} />
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
                  <input type="checkbox" checked={ferSeparate} onChange={(e) => setFerSeparate(e.target.checked)} />
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
                  />
                </div>
                <div>
                  <label className="text-sm text-gray-600">Immagine (URL)</label>
                  <input
                    value={imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                    className="w-full mt-1 rounded-xl border px-3 py-2"
                    placeholder="https://…"
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
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-sm text-gray-600">Tag (separati da virgola)</label>
                  <input value={tags} onChange={(e) => setTags(e.target.value)} className="w-full mt-1 rounded-xl border px-3 py-2" />
                </div>
              </div>
            </section>

            <div className="flex items-center justify-between">
              <button
                disabled={!canRun}
                className="rounded-xl bg-black text-white px-3 py-2 disabled:opacity-50"
                onClick={callApiGenerateBundles}
              >
                Crea biglietti
              </button>
              <span className="text-xs text-gray-600">Stima biglietti: {comboCount || 0}</span>
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
              <p className="text-xs text-gray-600 mt-1">Orari validi (ordinati): {timesInfo.valid.join(", ")}</p>
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
      </div>
    </div>
  );
}

/* ---------------- Sotto-componenti ---------------- */

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

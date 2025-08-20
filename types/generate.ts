// types/generate.ts

// Giorni/Tipi
export type DayType = "weekday" | "friday" | "saturday" | "sunday" | "holiday";

// Tipi di biglietto
export type TicketType = "unico" | "adulto" | "bambino" | "handicap";

// Formati stringa attesi (non validati a runtime qui)
export type YYYY_MM = string;      // es. "2025-12"
export type YYYY_MM_DD = string;   // es. "2025-12-08"
export type HH_mm = string;        // es. "11:30"

// Prezzi in EURO per tipo biglietto (UI in €, sotto cofano convertiremo in cent nei layer applicativi)
export type PriceTierEuro = Partial<Record<TicketType, number>>;

export type PricesEuro = {
  holiday?: PriceTierEuro;
  saturday?: PriceTierEuro;
  sunday?: PriceTierEuro;
  friday?: PriceTierEuro;
  feriali?: PriceTierEuro & {
    // opzionale: prezzi per singoli giorni feriali (lun–gio)
    perDay?: {
      mon?: Omit<PriceTierEuro, "unico">; // esclude "unico" se usi tripla
      tue?: Omit<PriceTierEuro, "unico">;
      wed?: Omit<PriceTierEuro, "unico">;
      thu?: Omit<PriceTierEuro, "unico">;
    };
  };
};

// Eccezioni per data specifica (override dei prezzi)
export type ExceptionsByDate = Record<YYYY_MM_DD, PriceTierEuro>;

// Input manuale
export type ManualInput = {
  source: "manual";
  eventHandle: string;
  startDate: YYYY_MM_DD; // compreso
  endDate: YYYY_MM_DD;   // compreso
  weekdaySlots: HH_mm[]; // slot per Lun–Gio (e Ven se fridayAsWeekend=false)
  weekendSlots: HH_mm[]; // slot per Sab/Dom (e Ven se fridayAsWeekend=true)
  capacityPerSlot: number;
  locationId?: string; // se omesso, si usa getDefaultLocationId()
  fridayAsWeekend: boolean;
  /** nome chiave volutamente con simbolo € per chiarezza dominio */
  "prices€": PricesEuro;
  exceptionsByDate?: ExceptionsByDate;
};

// Input da feed mesi (usa /api/events-feed)
export type FeedInput = {
  source: "feed";
  eventHandle: string;
  months: YYYY_MM[]; // es. ["2025-12","2026-01"]
  capacityPerSlot: number;
  locationId?: string;
  fridayAsWeekend: boolean;
  "prices€": PricesEuro;
  exceptionsByDate?: ExceptionsByDate;
};

// Union dell’input
export type GenerateInput = ManualInput | FeedInput;

// Preview di una riga generata
export type PreviewItem = {
  date: YYYY_MM_DD;
  time: HH_mm;
  dayType?: DayType;               // weekday | friday | saturday | sunday | holiday
  "pricePlan€"?: PriceTierEuro;    // prezzi applicati per questo slot (in Euro)
  mode?: "unico" | "triple";       // 1 variante (unico) o 3 varianti (adulto/bambino/handicap)

  seatProductId?: string;          // prodotto "Posto" (nascosto)
  bundleProductId?: string;        // prodotto "Biglietto" (visibile)
  variantMap?: {                   // mappa varianti bundle
    unico?: string;
    adulto?: string;
    bambino?: string;
    handicap?: string;
  };
  warnings?: string[];
};


// Riepilogo conto elementi
export type GenerateSummary = {
  seatsCreated: number;    // prodotti "Posto" creati
  bundlesCreated: number;  // prodotti "Biglietto" creati
  variantsCreated: number; // varianti bundle create
};

// Output server
export type GenerateResponse = {
  ok: boolean;
  summary: GenerateSummary;
  preview?: PreviewItem[]; // max ~10 righe in dryRun
  warnings?: string[];
};

// Type guards di comodo
export function isManualInput(input: GenerateInput): input is ManualInput {
  return input.source === "manual";
}
export function isFeedInput(input: GenerateInput): input is FeedInput {
  return input.source === "feed";
}

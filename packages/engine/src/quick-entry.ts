// Saisie rapide d'une allocation en langage simple (ADR-002 §5) : « Refonte 6h lun-mer », « 50 % jusqu'au 28 »,
// « ? Pitch 4h demain », « Audit 7,5h du 3 au 7 ». Pur : rend un brouillon pour l'aperçu en direct, jamais d'écriture.
//  * Ordre des mots libre ; FR et EN (jours, « jusqu'au » / « until », « du X au Y » / « from X to Y »).
//  * Jours de semaine : première occurrence à partir d'aujourd'hui, fin à partir du début. « jusqu'au N » : prochain jour N
//    du mois (aujourd'hui compris) ; « jusqu'au vendredi » : prochain vendredi à partir du début. Dates numériques J/M en FR, M/D en EN ; dates ISO acceptées partout.
//  * Ce qui reste est le nom du projet, rapproché sans accents ni casse (préfixe de mot, puis sous-chaîne).
//  * Rien n'est deviné : quantité, dates ou projet manquants ou ambigus sont listés dans `missing` / `candidates`, le
//    client applique ses défauts (ou demande). Codes stables, pas de texte UI (ADR-003).
import { addDays, addMonths, toMs, DAY_MS } from "./dates";

export type QuickLocale = "fr" | "en";

export interface QuickProject { id: string; name: string }

export interface QuickContext {
  /** Date du jour dans le fuseau du compte (todayIn). */
  today: string;
  locale: QuickLocale;
  projects: readonly QuickProject[];
}

export interface QuickDraft {
  projectId: string | null;
  /** Texte libre restant, rapproché des projets. */
  projectQuery: string;
  /** Projets possibles quand le texte en désigne plusieurs. */
  candidates: QuickProject[];
  mode: "hours" | "percentage" | null;
  hoursPerDay: number | null;
  percent: number | null;
  startDate: string | null;
  endDate: string | null;
  tentative: boolean;
  missing: ("project" | "amount" | "dates")[];
  /** Morceaux non compris (le client peut les surligner). */
  invalid: ("AMOUNT_OUT_OF_RANGE" | "DATE_INVALID" | "DATE_RANGE_INVERTED")[];
}

const DAYS: Record<QuickLocale, string[][]> = {
  // index 0 = lundi (ISO), formes acceptées par jour
  fr: [["lun", "lundi"], ["mar", "mardi"], ["mer", "mercredi"], ["jeu", "jeudi"], ["ven", "vendredi"], ["sam", "samedi"], ["dim", "dimanche"]],
  en: [["mon", "monday"], ["tue", "tues", "tuesday"], ["wed", "wednesday"], ["thu", "thur", "thurs", "thursday"], ["fri", "friday"], ["sat", "saturday"], ["sun", "sunday"]],
};
const WORDS = {
  fr: { today: ["aujourd'hui", "aujourdhui", "auj"], tomorrow: ["demain"], until: ["jusqu'au", "jusquau", "jusqu'à", "jusqua"], from: ["du"], to: ["au"], tentative: ["tentatif", "tentative"] },
  en: { today: ["today"], tomorrow: ["tomorrow"], until: ["until", "till", "to"], from: ["from"], to: ["to"], tentative: ["tentative"] },
} as const;

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const isoDow = (d: string) => ((new Date(toMs(d)).getUTCDay() + 6) % 7);
const validIso = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(toMs(d)) && new Date(toMs(d)).toISOString().slice(0, 10) === d;
const pad = (n: number) => String(n).padStart(2, "0");

function dayIndex(word: string, locale: QuickLocale): number | null {
  const w = fold(word).replace(/\.$/, "");
  const i = DAYS[locale].findIndex((forms) => forms.includes(w));
  return i < 0 ? null : i;
}

/** Prochaine date (>= from) tombant tel jour ISO (0 = lundi). */
const nextDow = (from: string, dow: number) => addDays(from, (dow - isoDow(from) + 7) % 7);

/** Prochaine date (>= from) de jour du mois `n` ; mois sans ce jour (31 avril) sautés. */
function nextDayOfMonth(from: string, n: number): string | null {
  if (n < 1 || n > 31) return null;
  for (let k = 0; k < 13; k++) {
    const month = addMonths(`${from.slice(0, 8)}01`, k);
    const d = `${month.slice(0, 8)}${pad(n)}`;
    if (validIso(d) && d >= from) return d;
  }
  return null;
}

/** « 28 », « 28/04 », « 28/04/2026 » (FR : J/M ; EN : M/D), ou ISO. */
function parseDate(tok: string, ctx: QuickContext): string | null | "invalid" {
  if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) return validIso(tok) ? tok : "invalid";
  const m = /^(\d{1,2})(?:\/(\d{1,2})(?:\/(\d{2}|\d{4}))?)?$/.exec(tok);
  if (!m) return null;
  if (m[2] === undefined) return nextDayOfMonth(ctx.today, Number(m[1])) ?? "invalid";
  const [a, b] = [Number(m[1]), Number(m[2])];
  const [day, month] = ctx.locale === "fr" ? [a, b] : [b, a];
  const year = m[3] === undefined ? Number(ctx.today.slice(0, 4)) : Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
  let d = `${year}-${pad(month)}-${pad(day)}`;
  if (!validIso(d)) return "invalid";
  if (m[3] === undefined && d < ctx.today) d = `${year + 1}-${pad(month)}-${pad(day)}`; // « 03/01 » en décembre : l'an prochain
  return validIso(d) ? d : "invalid";
}

export function parseQuickEntry(text: string, ctx: QuickContext): QuickDraft {
  const W = WORDS[ctx.locale];
  const draft: QuickDraft = {
    projectId: null, projectQuery: "", candidates: [], mode: null, hoursPerDay: null, percent: null,
    startDate: null, endDate: null, tentative: false, missing: [], invalid: [],
  };
  // Normalisation : « 6 h » -> « 6h », « 50 % » -> « 50% », « lun - mer » -> « lun-mer », apostrophes typographiques.
  const norm = text.replace(/[’`]/g, "'").replace(/(\d)\s+(h|heures?|hours?|hrs?)\b/gi, "$1$2").replace(/(\d)\s+%/g, "$1%").replace(/\s*-\s*/g, "-");
  let rest: string[] = [];
  const toks = norm.split(/\s+/).filter(Boolean);
  let until: string | null = null;
  const setRange = (s: string, e: string) => { draft.startDate = s; draft.endDate = e; };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    const low = fold(t);
    if (t === "?" || (W.tentative as readonly string[]).includes(low)) { draft.tentative = true; continue; }
    if (t.startsWith("?") && t.length > 1) { draft.tentative = true; rest.push(t.slice(1)); continue; }

    const amount = /^(\d+(?:[.,]\d+)?)(h|heures?|hours?|hrs?|%)$/i.exec(t);
    if (amount) {
      const v = Number(amount[1]!.replace(",", "."));
      if (amount[2] === "%") {
        if (v > 0 && v <= 500) { draft.mode = "percentage"; draft.percent = v; draft.hoursPerDay = null; } else draft.invalid.push("AMOUNT_OUT_OF_RANGE");
      } else if (v > 0 && v <= 24) { draft.mode = "hours"; draft.hoursPerDay = v; draft.percent = null; } else draft.invalid.push("AMOUNT_OUT_OF_RANGE");
      continue;
    }

    if ((W.today as readonly string[]).includes(low)) { setRange(ctx.today, ctx.today); continue; }
    if ((W.tomorrow as readonly string[]).includes(low)) { const d = addDays(ctx.today, 1); setRange(d, d); continue; }

    // Jour ou plage de jours de semaine : « lun », « lun-mer »
    const days = low.split("-");
    if (days.length <= 2 && days.every((d) => dayIndex(d, ctx.locale) !== null)) {
      const s = nextDow(ctx.today, dayIndex(days[0]!, ctx.locale)!);
      // « lun au mer » / « mon to wed » : même plage que « lun-mer »
      const linked = days.length === 1 && toks[i + 2] && (W.to as readonly string[]).includes(fold(toks[i + 1] ?? "")) ? dayIndex(toks[i + 2]!, ctx.locale) : null;
      if (linked !== null) { setRange(s, nextDow(s, linked)); i += 2; continue; }
      setRange(s, days.length === 2 ? nextDow(s, dayIndex(days[1]!, ctx.locale)!) : s);
      continue;
    }

    // « jusqu'au 28 » (FR : parfois collé, « jusqu'au28 » non géré) / « until 28 »
    if ((W.until as readonly string[]).includes(low) && toks[i + 1] && !(ctx.locale === "en" && draft.startDate && low === "to")) {
      const dow = dayIndex(toks[i + 1]!, ctx.locale);
      if (dow !== null) { until = nextDow(draft.startDate ?? ctx.today, dow); i++; continue; } // « jusqu'au vendredi »
      const d = parseDate(toks[i + 1]!.replace(/(st|nd|rd|th)$/i, ""), ctx);
      if (d && d !== "invalid") { until = d; i++; continue; }
      if (d === "invalid") { draft.invalid.push("DATE_INVALID"); i++; continue; }
    }

    // « du 3 au 7 » / « from 3 to 7 »
    if ((W.from as readonly string[]).includes(low) && toks[i + 2] && (W.to as readonly string[]).includes(fold(toks[i + 2]!)) && toks[i + 3]) {
      const s = parseDate(toks[i + 1]!, ctx);
      const e = s && s !== "invalid" ? parseDate(toks[i + 3]!, { ...ctx, today: s }) : null;
      if (s && s !== "invalid" && e && e !== "invalid") { setRange(s, e); i += 3; continue; }
      if (s === "invalid" || e === "invalid") { draft.invalid.push("DATE_INVALID"); i += 3; continue; }
    }

    // Date seule (ISO ou J/M) : un jour
    if (/^\d{4}-\d{2}-\d{2}$/.test(t) || /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(t)) {
      const d = parseDate(t, ctx);
      if (d === "invalid" || d === null) draft.invalid.push("DATE_INVALID");
      else setRange(d, d);
      continue;
    }
    rest.push(t);
  }

  if (until) {
    if (!draft.startDate) draft.startDate = ctx.today;
    draft.endDate = until;
  }
  if (draft.startDate && draft.endDate && draft.endDate < draft.startDate) {
    draft.invalid.push("DATE_RANGE_INVERTED");
    draft.startDate = draft.endDate = null;
  }

  rest = rest.filter((w) => !["de", "pour", "for", "on", "le", "the"].includes(fold(w)));
  draft.projectQuery = rest.join(" ").trim();
  if (draft.projectQuery) {
    const q = fold(draft.projectQuery);
    const exact = ctx.projects.filter((p) => fold(p.name) === q);
    const prefix = ctx.projects.filter((p) => fold(p.name).split(/\s+/).some((w) => w.startsWith(q)) || fold(p.name).startsWith(q));
    const sub = ctx.projects.filter((p) => fold(p.name).includes(q));
    const found = exact.length ? exact : prefix.length ? prefix : sub;
    if (found.length === 1) draft.projectId = found[0]!.id;
    else draft.candidates = found.slice(0, 10);
  }
  if (!draft.projectId) draft.missing.push("project");
  if (!draft.mode) draft.missing.push("amount");
  if (!draft.startDate) draft.missing.push("dates");
  return draft;
}

/** Nombre de jours du brouillon (pour l'aperçu), null sans dates. */
export const draftDays = (d: QuickDraft) =>
  d.startDate && d.endDate ? Math.round((toMs(d.endDate) - toMs(d.startDate)) / DAY_MS) + 1 : null;

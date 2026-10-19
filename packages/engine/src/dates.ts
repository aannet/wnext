// Dates ISO "YYYY-MM-DD" sans fuseau : tout se calcule en UTC minuit.
export const MAX_RANGE_DAYS = 400;
export const DAY_MS = 86_400_000;

export const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Heures ouvrées d'un jour : ISODOW 1..7 = lundi..dimanche -> index 0..6 (ADR-001). */
export function workHours(workDaysHours: readonly number[], day: string): number {
  return hoursAt(workDaysHours, (new Date(toMs(day)).getUTCDay() + 6) % 7);
}

/** Heures ouvrées à l'index ISO `dow` (0 = lundi) ; 0 hors du tableau. */
export const hoursAt = (workDaysHours: readonly number[], dow: number): number => workDaysHours[dow] ?? 0;

/** Même contrôle que les fonctions SQL : plage ordonnée et <= 400 jours. */
export function assertRange(from: string, to: string): void {
  const span = (toMs(to) - toMs(from)) / DAY_MS;
  if (!Number.isFinite(span) || span < 0 || span > MAX_RANGE_DAYS) {
    throw new Error(`INVALID_RANGE: ${from}..${to} (plage invalide ou > ${MAX_RANGE_DAYS} jours)`);
  }
}

/** Ajoute k mois en gardant le jour d'origine, ramené en fin de mois s'il n'existe pas (31/01 + 1 mois = 28/02). */
export function addMonths(d: string, k: number): string {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + k;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return toIso(Date.UTC(ny, nm, Math.min(day, last)));
}

export const monthsBetween = (a: string, b: string) =>
  (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

export const addDays = (d: string, n: number) => toIso(toMs(d) + n * DAY_MS);

/** Calendrier d'une fenêtre, calculé une fois : jours ISO et index de jour ISO (0 = lundi), pour les boucles chaudes. */
export interface WindowDays { first: number; iso: string[]; dow: number[] }
export function windowDays(from: string, to: string): WindowDays {
  const first = Math.round(toMs(from) / DAY_MS);
  const n = Math.round((toMs(to) - toMs(from)) / DAY_MS) + 1;
  const iso: string[] = new Array(n);
  const dow: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    iso[i] = toIso((first + i) * DAY_MS);
    dow[i] = (first + i + 3) % 7; // 1970-01-01 est un jeudi (index 3)
  }
  return { first, iso, dow };
}

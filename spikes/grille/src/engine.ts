// Moteur de layout pur (aucun accès DOM). Jours = indices entiers depuis DAY0.
export interface Alloc { id: number; person: number; start: number; len: number; pct: number; hue: number }
export interface Placed { a: Alloc; y: number; h: number }
export interface RowLayout { placed: Placed[]; over: boolean }

export function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function generate(people: number, days: number, seed = 42): Alloc[][] {
  const r = mulberry32(seed); let id = 0; const out: Alloc[][] = [];
  for (let p = 0; p < people; p++) {
    const row: Alloc[] = []; let d = Math.floor(r() * 5);
    while (d < days) {
      const len = 1 + Math.floor(r() * 15); const pct = [0.25, 0.5, 0.5, 0.75, 1][Math.floor(r() * 5)];
      row.push({ id: id++, person: p, start: d, len: Math.min(len, days - d), pct, hue: Math.floor(r() * 360) });
      if (r() < 0.2) row.push({ id: id++, person: p, start: d + Math.floor(len / 2), len: 1 + Math.floor(r() * 6), pct: 0.5, hue: Math.floor(r() * 360) });
      d += len + Math.floor(r() * 4);
    }
    row.sort((a, b) => a.start - b.start || a.id - b.id); out.push(row);
  }
  return out;
}

/** Empilement vertical glouton + détection de sur-allocation (somme des % > 1 sur un jour). */
export function layoutRow(allocs: Alloc[], rowH: number): RowLayout {
  const placed: Placed[] = []; const load = new Map<number, number>(); let over = false;
  for (const a of allocs) {
    const h = Math.max(4, Math.round(a.pct * (rowH - 4)));
    let y = 0;
    for (const q of placed) if (q.a.start < a.start + a.len && a.start < q.a.start + q.a.len) y = Math.max(y, q.y + q.h);
    placed.push({ a, y, h });
    for (let d = a.start; d < a.start + a.len; d++) { const v = (load.get(d) ?? 0) + a.pct; load.set(d, v); if (v > 1.0001) over = true; }
  }
  return { placed, over };
}

export const snap = (px: number, pxPerDay: number) => Math.round(px / pxPerDay);

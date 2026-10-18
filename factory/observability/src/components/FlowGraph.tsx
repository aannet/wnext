"use client";

import { useState } from "react";
import { isAuto } from "./shared";
import type { EdgeKind, FlowEdge } from "@/lib/flow";

// Positions des 13 agents (viewBox 800 x 330) : pipeline en haut, orchestration au milieu, support en bas.
const W = 112, H = 30;
const POS: Record<string, [number, number]> = {
  architecte: [70, 40], specifieur: [235, 40], testeur: [400, 40], implementeur: [565, 40], sentinelle: [730, 40],
  orchestrateur: [235, 165], router: [400, 165], integrateur: [565, 165], reviseur: [730, 165],
  scribe: [70, 290], depanneur: [400, 290], superviseur: [235, 290], introspecteur: [565, 290],
};

const KIND: Record<EdgeKind, { label: string; glyph: string; color: string; dash?: string; extra: number }> = {
  handoff: { label: "passage de relais", glyph: "→", color: "var(--ink-3)", extra: 0 },
  retry: { label: "retry", glyph: "↻", color: "var(--serious)", dash: "6 4", extra: 1 },
  escalate: { label: "escalade de modèle", glyph: "▲", color: "var(--warning)", extra: 2 },
  loop: { label: "boucle", glyph: "∞", color: "var(--critical)", dash: "2 4", extra: 1 },
  kill: { label: "arrêt (kill-switch)", glyph: "■", color: "var(--critical)", extra: 2 },
};

/** Intersection du segment centre -> (tx, ty) avec le rectangle du nœud. */
function clip(cx: number, cy: number, tx: number, ty: number): [number, number] {
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const s = Math.min(dx !== 0 ? W / 2 / Math.abs(dx) : Infinity, dy !== 0 ? H / 2 / Math.abs(dy) : Infinity);
  return [cx + dx * s, cy + dy * s];
}

export function FlowGraph({ edges }: { edges: FlowEdge[] }) {
  const [all, setAll] = useState(false);
  const used = new Set(edges.flatMap((e) => [e.from, e.to]));
  const visible = Object.entries(POS).filter(([n]) => all || used.has(n));
  // Cadre ajusté aux nœuds affichés pour garder le sous-ensemble lisible (pas de grands vides).
  const PAD = 24;
  const xs = visible.map(([, p]) => p[0]), ys = visible.map(([, p]) => p[1]);
  const vx = visible.length ? Math.min(...xs) - W / 2 - PAD : 0, vy = visible.length ? Math.min(...ys) - H / 2 - PAD - 12 : 0;
  const vw = visible.length ? Math.max(...xs) + W / 2 + PAD - vx : 800, vh = visible.length ? Math.max(...ys) + H / 2 + PAD + 12 - vy : 330;
  const total = edges.reduce((a, e) => a + e.count, 0);
  return (
    <>
      <label className="small">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Afficher tous les agents
        {!all && <span className="muted"> ({visible.length} sur {Object.keys(POS).length} sont actifs dans ce filtre)</span>}
      </label>
      {visible.length === 0 && !all ? <p className="muted">Aucun lien pour ce filtre.</p> : (
      <svg viewBox={`${vx} ${vy} ${vw} ${vh}`} style={{ maxHeight: Math.max(160, vh) }} className="flow" role="img" aria-label={`Graphe des flux entre agents : ${edges.length} liens, ${total} passages de relais`}>
        <defs>
          {(Object.keys(KIND) as EdgeKind[]).map((k) => (
            <marker key={k} id={`ar-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0L10 5L0 10z" style={{ fill: KIND[k].color }} />
            </marker>
          ))}
        </defs>
        {edges.map((e) => {
          const a = POS[e.from], b = POS[e.to], k = KIND[e.kind];
          if (!a || !b) return null;
          // Courbure : le sens (de -> vers) détermine le côté, pour séparer A->B de B->A.
          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
          const nx = -(b[1] - a[1]), ny = b[0] - a[0];
          const len = Math.hypot(nx, ny) || 1;
          const off = (e.from < e.to ? 1 : -1) * (28 + k.extra * 10);
          const cx = mx + (nx / len) * off, cy = my + (ny / len) * off;
          const [x1, y1] = clip(a[0], a[1], cx, cy);
          const [x2, y2] = clip(b[0], b[1], cx, cy);
          const lx = 0.25 * x1 + 0.5 * cx + 0.25 * x2, ly = 0.25 * y1 + 0.5 * cy + 0.25 * y2;
          const sw = 1.2 + Math.min(4.5, Math.log2(e.count + 1));
          const tip = `${e.from} → ${e.to} · ${k.label} · ${e.count} fois sur ${e.lines} ligne${e.lines > 1 ? "s" : ""}`;
          return (
            <g key={`${e.from}>${e.to}>${e.kind}`}>
              <title>{tip}</title>
              <path d={`M${x1},${y1} Q${cx},${cy} ${x2},${y2}`} fill="none" strokeWidth={sw} strokeDasharray={k.dash} markerEnd={`url(#ar-${e.kind})`} style={{ stroke: k.color }} />
              <text x={lx} y={ly} className="elabel" textAnchor="middle" dominantBaseline="middle">{k.glyph} {e.count}</text>
            </g>
          );
        })}
        {visible.map(([name, [x, y]]) => (
          <g key={name} opacity={used.has(name) ? 1 : 0.45}>
            <rect x={x - W / 2} y={y - H / 2} width={W} height={H} rx={6} className={isAuto(name) ? "node auto" : "node"} strokeDasharray={isAuto(name) ? "4 3" : undefined} />
            <text x={x} y={y} textAnchor="middle" dominantBaseline="central" className="nlabel">{name}</text>
          </g>
        ))}
      </svg>
      )}
      <div className="legend small" aria-label="Légende des liens">
        {(Object.keys(KIND) as EdgeKind[]).map((k) => (
          <span key={k}>
            <svg width="30" height="8" aria-hidden="true"><line x1="0" y1="4" x2="30" y2="4" strokeWidth="2" strokeDasharray={KIND[k].dash} style={{ stroke: KIND[k].color }} /></svg>{" "}
            {KIND[k].glyph} {KIND[k].label}
          </span>
        ))}
        <span className="muted">épaisseur = nombre de passages · cadre pointillé = automatisme (code)</span>
      </div>
      <details>
        <summary>Vue tableau</summary>
        <div className="tablewrap">
          <table>
            <thead><tr><th>De</th><th>Vers</th><th>Lien</th><th className="r">Fois</th><th className="r">Lignes</th></tr></thead>
            <tbody>{edges.map((e) => <tr key={`${e.from}>${e.to}>${e.kind}`}><td>{e.from}</td><td>{e.to}</td><td>{KIND[e.kind].glyph} {KIND[e.kind].label}</td><td className="r num">{e.count}</td><td className="r num">{e.lines}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </>
  );
}

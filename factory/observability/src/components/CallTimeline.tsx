"use client";

import { useMemo, useState } from "react";
import type { Call } from "@/lib/flow";
import { AGENTS } from "@/lib/types";
import { STATUS, fmtAge, modelMeta } from "./shared";

const LABEL_W = 112, LANE_H = 24, BLOCK_H = 16, STEP = 14, BLOCK_W = 10, MAX_CALLS = 300;
type Mode = "seq" | "time";

const STROKE: Record<string, string> = { error: "var(--critical)", blocked: "var(--serious)", looping: "var(--critical)", killed: "var(--critical)", retry: "var(--warning)", escalated: "var(--warning)" };

export function CallTimeline({ calls, single }: { calls: Call[]; single: boolean }) {
  const [mode, setMode] = useState<Mode>("seq");
  const [tip, setTip] = useState<{ x: number; y: number; c: Call } | null>(null);
  const shown = useMemo(() => calls.slice(-MAX_CALLS), [calls]);

  const lanes = AGENTS.filter((a) => shown.some((c) => c.agent === a));
  const laneY = (agent: string) => lanes.indexOf(agent as never) * LANE_H + 6;

  const t0 = shown.length ? Math.min(...shown.map((c) => c.start_ms)) : 0;
  const t1 = shown.length ? Math.max(...shown.map((c) => c.end_ms), t0 + 1) : 1;
  const chartW = mode === "seq" ? Math.max(480, shown.length * STEP + 20) : 640;
  const x = (c: Call, i: number) => LABEL_W + (mode === "seq" ? i * STEP : ((c.start_ms - t0) / (t1 - t0)) * chartW);
  const w = (c: Call) => (mode === "seq" ? BLOCK_W : Math.max(3, (c.duration_ms / (t1 - t0)) * chartW));
  const index = new Map(shown.map((c, i) => [c.id, i]));
  const height = lanes.length * LANE_H + 12;

  if (!shown.length) return <p className="muted">Aucun événement pour ce filtre.</p>;

  return (
    <>
      <div className="row small" style={{ marginBottom: 8 }}>
        <span className="muted">Échelle :</span>
        <button aria-pressed={mode === "seq"} className={mode === "seq" ? "on" : ""} onClick={() => setMode("seq")}>Séquence</button>
        <button aria-pressed={mode === "time"} className={mode === "time" ? "on" : ""} onClick={() => setMode("time")}>Temps réel</button>
        <span className="muted">{shown.length} appel{shown.length > 1 ? "s" : ""}{calls.length > shown.length ? ` (les ${MAX_CALLS} derniers)` : ""}{single ? "" : " · flèches : choisir une ligne"}</span>
      </div>
      <div className="tablewrap">
        <svg width={LABEL_W + chartW + 20} height={height} role="img" aria-label={`Timeline : ${shown.length} appels sur ${lanes.length} agents`} className="swim">
          <defs>
            <marker id="tl-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" style={{ fill: "var(--ink-3)" }} /></marker>
          </defs>
          {lanes.map((a) => (
            <g key={a}>
              <line x1={LABEL_W} x2={LABEL_W + chartW + 10} y1={laneY(a) + BLOCK_H / 2} y2={laneY(a) + BLOCK_H / 2} style={{ stroke: "var(--grid)" }} />
              <text x={LABEL_W - 8} y={laneY(a) + BLOCK_H / 2} textAnchor="end" dominantBaseline="central" className="nlabel">{a}</text>
            </g>
          ))}
          {single && shown.map((c, i) => {
            if (c.kind === "call" || c.prev_id === null) return null;
            const pi = index.get(c.prev_id);
            if (pi === undefined) return null;
            const p = shown[pi];
            return <line key={`l${c.id}`} x1={x(p, pi) + w(p)} y1={laneY(p.agent) + BLOCK_H / 2} x2={x(c, i)} y2={laneY(c.agent) + BLOCK_H / 2} strokeWidth={1} markerEnd="url(#tl-ar)" style={{ stroke: "var(--ink-3)" }} opacity={0.7} />;
          })}
          {shown.map((c, i) => (
            <rect key={c.id} x={x(c, i)} y={laneY(c.agent)} width={w(c)} height={BLOCK_H} rx={2}
              style={{ fill: modelMeta(c.model).color, stroke: STROKE[c.status] ?? "transparent" }} strokeWidth={STROKE[c.status] ? 2 : 0}
              tabIndex={shown.length <= 80 ? 0 : undefined}
              aria-label={`${c.agent}, ${c.action}, ${modelMeta(c.model).label}, ${STATUS[c.status]?.label ?? c.status}${c.caller ? `, appelé par ${c.caller}` : ""}`}
              onPointerMove={(e) => setTip({ x: e.clientX, y: e.clientY, c })} onPointerLeave={() => setTip(null)}
              onFocus={(e) => { const r = e.currentTarget.getBoundingClientRect(); setTip({ x: r.left, y: r.bottom, c }); }} onBlur={() => setTip(null)} />
          ))}
        </svg>
      </div>
      {tip && (
        <div className="tip" role="tooltip" style={{ left: Math.min(tip.x + 12, typeof window !== "undefined" ? window.innerWidth - 270 : tip.x), top: tip.y + 12 }}>
          <b>{tip.c.agent}</b> · {tip.c.action}<br />
          <span className="muted">{modelMeta(tip.c.model).label} · {STATUS[tip.c.status]?.label ?? tip.c.status} · {(tip.c.duration_ms / 1000).toFixed(1)} s{tip.c.attempt ? ` · essai ${tip.c.attempt}` : ""}</span><br />
          <span className="muted">{tip.c.line}{tip.c.caller ? ` · appelé par ${tip.c.caller}` : ""}</span>
        </div>
      )}
      <details>
        <summary>Liste des appels</summary>
        <ol className="timeline calls" aria-label="Derniers appels">
          {[...shown].reverse().slice(0, 80).map((c) => {
            const st = STATUS[c.status] ?? STATUS.ok;
            return (
              <li key={c.id}>
                <span className="num muted">{c.ts.slice(11, 23)}</span>
                <span>{c.line}</span>
                <span className="c">{c.caller && c.kind !== "call" ? <><span className="muted">{c.caller} →</span> </> : null}{c.agent} · {c.action} <span className="muted">· {modelMeta(c.model).short === "·" ? "—" : modelMeta(c.model).short}{c.kind !== "call" && c.kind !== "handoff" ? ` · ${c.kind}` : ""}</span></span>
                <span className={`badge st-${c.status}`}><span className="ic" aria-hidden="true">{st.icon}</span>{st.label}</span>
              </li>
            );
          })}
        </ol>
        <p className="small muted">Plus récent en premier ; il y a {fmtAge(Math.max(0, Math.round((Date.now() - Date.parse(shown[shown.length - 1].ts)) / 1000)))} pour le dernier appel.</p>
      </details>
    </>
  );
}

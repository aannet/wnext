"use client";

import { useEffect, useState } from "react";
import type { Production as Data, Unit } from "@/lib/production";
import { PHASES } from "@/lib/types";
import { AGENT_ABBR, AGENT_KIND, MODELS, fmtAge, isAuto, modelMeta } from "./shared";
import { pickLoopLine } from "@/lib/loop";
import { LineLoop } from "./LineLoop";
import { FlowGraph } from "./FlowGraph";
import { CallTimeline } from "./CallTimeline";

const STATE_GLYPH = { running: "▣", muted: "◌", blocked: "⏸", idle: "·" } as const;
const STATE_LABEL = { running: "actif", muted: "muet", blocked: "bloqué", idle: "inactif" } as const;
const MAX_SQUARES = 12;

/** Petit carré : couleur = modèle, lettre = modèle, bordure/glyphe = état (jamais la couleur seule). */
export function Square({ model, state, title }: { model: string; state?: Unit["state"]; title: string }) {
  const m = modelMeta(model);
  return (
    <span className={`sq ${state ? `sq-${state}` : ""}`} style={{ background: m.color }} title={title} role="img" aria-label={title}>
      {state === "blocked" ? "⏸" : m.short}
    </span>
  );
}

const unitTitle = (u: Unit) => `${u.line} · ${u.action} · ${modelMeta(u.model).label} · ${STATE_LABEL[u.state]} · il y a ${fmtAge(u.idle_s)}`;

export function Production({ tick }: { tick: number }) {
  const [data, setData] = useState<Data | null>(null);
  const [phase, setPhase] = useState<string>("");
  const [line, setLine] = useState<string>("");
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams();
    if (phase) qs.set("phase", phase);
    if (line) qs.set("line", line);
    fetch(`/api/production?${qs}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: Data) => { if (!cancelled) { setData(d); setError(false); } })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [tick, phase, line]);

  if (!data) return <p className="muted">{error ? "Données indisponibles." : "Chargement…"}</p>;

  const lineOptions = data.lines.filter((l) => !phase || l.phase === phase);
  const cell = (p: string, a: string) => data.matrix.find((c) => c.phase === p && c.agent === a);
  const heldLines = [...new Set(data.agents.flatMap((a) => a.units.filter((u) => u.state !== "muted").map((u) => u.line)))].filter((l) => l !== "_phase" && l !== "_global").sort();
  const loopLine = pickLoopLine(line, heldLines, lineOptions.map((l) => l.line).filter((l) => l !== "_phase" && l !== "_global"));
  const pickPhase = (p: string) => { setPhase((cur) => (cur === p ? "" : p)); setLine(""); };

  return (
    <>
      <section className="card filters" aria-label="Filtres">
        <label>Phase{" "}
          <select value={phase} onChange={(e) => { setPhase(e.target.value); setLine(""); }}>
            <option value="">Toutes</option>
            {PHASES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label>Ligne{" "}
          <select value={line} onChange={(e) => setLine(e.target.value)}>
            <option value="">Toutes</option>
            {lineOptions.map((l) => <option key={l.line} value={l.line}>{l.line}</option>)}
          </select>
        </label>
        <span className="muted" role="status" aria-live="polite">
          {data.counts.running} agent{data.counts.running > 1 ? "s" : ""} actif{data.counts.running > 1 ? "s" : ""} · {data.counts.muted} muet{data.counts.muted > 1 ? "s" : ""} · {data.counts.blocked} bloqué{data.counts.blocked > 1 ? "s" : ""}
        </span>
        {(phase || line) && <button onClick={() => { setPhase(""); setLine(""); }}>Réinitialiser</button>}
      </section>

      <section className="card" aria-labelledby="h-now">
        <h2 id="h-now">Qui tourne maintenant</h2>
        <div className="legend" aria-label="Légende">
          {MODELS.map((m) => <span key={m.id} className="small"><Square model={m.id} title={m.label} /> {m.label}</span>)}
          <span className="small"><Square model="none" title="code déterministe" /> code déterministe</span>
          <span className="small muted">Un carré = une ligne ; bordure pleine = actif, pointillée = muet, ⏸ = bloqué.</span>
        </div>
        {([["llm", "Agents LLM"], ["auto", "Automatismes (code déterministe)"]] as const).map(([grp, title]) => {
          const list = data.agents.filter((a) => (grp === "auto") === isAuto(a.agent));
          return (
            <div key={grp} role="group" aria-labelledby={`g-${grp}`}>
              <h3 id={`g-${grp}`} className="grp">{title} <span className="muted small">({list.filter((a) => a.state !== "idle").length}/{list.length} en activité)</span></h3>
              <div className="agents">
                {list.map((a) => (
                  <div key={a.agent} className={`agent ag-${a.state}`}>
                    <div className="ah">
                      <span className="an">{STATE_GLYPH[a.state]} {a.agent}{AGENT_KIND[a.agent] === "light" && <span className="small muted"> · léger</span>}</span>
                      <span className="small muted">{a.last_model ? modelMeta(a.last_model).short === "·" ? "code" : modelMeta(a.last_model).label : "—"}</span>
                    </div>
                    <div className="squares">
                      {a.units.length === 0 && <span className="small muted">{a.idle_s === null ? "jamais vu" : `inactif · il y a ${fmtAge(a.idle_s)}`}</span>}
                      {a.units.slice(0, MAX_SQUARES).map((u) => <Square key={u.line} model={u.model} state={u.state} title={unitTitle(u)} />)}
                      {a.units.length > MAX_SQUARES && <span className="small muted">+{a.units.length - MAX_SQUARES}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </section>

      <section className="card" aria-labelledby="h-matrix">
        <h2 id="h-matrix">Matrice phase × agent</h2>
        <p className="small muted">Un carré par ligne ayant sollicité l’agent dans la phase, coloré par modèle dominant. Cliquer une phase ou une cellule filtre l’onglet.</p>
        <div className="tablewrap">
          <table className="matrix">
            <thead>
              <tr><th scope="col">Phase</th>{Object.keys(AGENT_ABBR).map((a) => <th key={a} scope="col" className="c"><abbr title={a}>{AGENT_ABBR[a]}</abbr></th>)}</tr>
            </thead>
            <tbody>
              {data.phases.map((p) => (
                <tr key={p.phase} className={phase === p.phase ? "sel" : ""}>
                  <th scope="row">
                    <button className="plain" aria-pressed={phase === p.phase} onClick={() => pickPhase(p.phase)}>
                      {p.phase} <span className="muted small">{p.state === "open" ? "● en cours" : p.state === "done" ? "✓ terminée" : "—"}</span>
                    </button>
                  </th>
                  {Object.keys(AGENT_ABBR).map((a) => {
                    const c = cell(p.phase, a);
                    return (
                      <td key={a} className="c">
                        {c ? (
                          <button className="plain cellbtn" onClick={() => pickPhase(p.phase)}
                            aria-label={`${p.phase}, ${a} : ${c.lines.length} ligne${c.lines.length > 1 ? "s" : ""}, ${c.events} événements`}>
                            {c.lines.slice(0, 6).map((l) => (
                              <span key={l.line} className="sq sm" style={{ background: modelMeta(l.model).color }}
                                title={`${l.line} · ${modelMeta(l.model).label} · ${l.events} évén.${l.errors ? ` · ${l.errors} en échec` : ""}`}>{l.errors ? "!" : ""}</span>
                            ))}
                            {c.lines.length > 6 && <span className="small muted">+{c.lines.length - 6}</span>}
                          </button>
                        ) : <span className="muted">·</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details>
          <summary>Vue tableau (lignes / événements)</summary>
          <div className="tablewrap">
            <table>
              <caption className="small muted" style={{ textAlign: "left" }}>Lignes distinctes / événements par phase et agent</caption>
              <thead><tr><th>Phase</th>{Object.keys(AGENT_ABBR).map((a) => <th className="r" key={a}>{AGENT_ABBR[a]}</th>)}</tr></thead>
              <tbody>
                {data.phases.map((p) => (
                  <tr key={p.phase}><td>{p.phase}</td>
                    {Object.keys(AGENT_ABBR).map((a) => { const c = cell(p.phase, a); return <td key={a} className="r num">{c ? `${c.lines.length} / ${c.events}` : "–"}</td>; })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      {loopLine && (
        <section className="card" aria-labelledby="h-loop">
          <h2 id="h-loop">Boucle d’une ligne · {loopLine}</h2>
          <LineLoop calls={data.calls} line={loopLine} />
        </section>
      )}

      <div className="cols2">
        <section className="card" aria-labelledby="h-flow">
          <h2 id="h-flow">Graphe des flux{phase ? ` · ${phase}` : ""}{line ? ` · ${line}` : ""}</h2>
          <FlowGraph edges={data.edges} />
        </section>
        <section className="card" aria-labelledby="h-calls">
          <h2 id="h-calls">Qui a appelé quoi</h2>
          <CallTimeline calls={data.calls} single={!!line} />
        </section>
      </div>
    </>
  );
}

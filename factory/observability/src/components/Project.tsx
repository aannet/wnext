"use client";

import { useEffect, useMemo, useState } from "react";
import type { Summary } from "@/lib/summary";
import type { Production } from "@/lib/production";
import { buildProject, type Health } from "@/lib/project";
import { LineLoop } from "./LineLoop";
import { fmtUsd, modelMeta, pct } from "./shared";

const HEALTH: Record<Health, { icon: string; label: string; cls: string }> = {
  ok: { icon: "●", label: "En bonne voie", cls: "st-ok" },
  watch: { icon: "▲", label: "À surveiller", cls: "st-retry" },
  blocked: { icon: "⬣", label: "Bloqué", cls: "st-killed" },
};
const PH_STATE = { empty: "à venir", open: "en cours", done: "terminée" } as const;
const PH_ICON = { empty: "○", open: "●", done: "✓" } as const;
const SEV_ICON = { warning: "▲", serious: "◆", critical: "⬣" } as const;
const STEP_ICON: Record<string, string> = { pending: "○", running: "●", done: "✓", failed: "✕", blocked: "⏸" };

/** Onglet « Projet » : santé, feuille de route par phase, lignes de la phase en cours, points de vigilance. */
export function Project({ sum, tick }: { sum: Summary; tick: number }) {
  const [prod, setProd] = useState<Production | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/production", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: Production) => { if (!cancelled) setProd(d); })
      .catch(() => { /* la vue reste sur les dernières données */ });
    return () => { cancelled = true; };
  }, [tick]);

  const view = useMemo(() => (prod ? buildProject(sum, prod) : null), [sum, prod]);
  if (!view || !prod) return <p className="muted">Chargement…</p>;

  const h = HEALTH[view.health];
  const cur = view.phases.find((p) => p.phase === view.current_phase);
  const ci = view.ci_first_pass;

  return (
    <>
      <section className="card health" aria-labelledby="h-health">
        <h2 id="h-health" className="sr">Santé du projet</h2>
        <div className="row">
          <span className={`badge hbadge ${h.cls}`}><span className="ic" aria-hidden="true">{h.icon}</span>{h.label}</span>
          <span className="muted">{view.health_reason}</span>
        </div>
        <p className="small muted" style={{ margin: "4px 0 0" }}>
          {cur ? <>Phase en cours : <strong>{cur.phase}</strong> {cur.label}</> : "Aucune phase démarrée."}
        </p>
      </section>

      <section aria-label="Indicateurs du projet" className="tiles">
        <div className="tile"><div className="v num">{view.merged_total}</div><div className="l">lignes mergées{cur ? ` · ${cur.merged} en ${cur.phase}` : ""}</div></div>
        <div className="tile"><div className="v num">{ci.rate === null ? "—" : pct(ci.rate)}</div><div className="l">CI au 1er passage (cible 60 %){ci.total ? ` · ${ci.passed}/${ci.total}` : ""}</div></div>
        <div className="tile"><div className="v num">{cur ? pct(cur.budget_pct) : "—"}</div><div className="l">budget {cur ? cur.phase : ""} consommé{cur ? ` · ${fmtUsd(cur.cost)}` : ""}</div></div>
        <div className="tile"><div className="v num">{view.watch.length}</div><div className="l">point{view.watch.length > 1 ? "s" : ""} à surveiller</div></div>
      </section>

      <section className="card" aria-labelledby="h-road">
        <h2 id="h-road">Feuille de route</h2>
        <ol className="road">
          {view.phases.map((p) => (
            <li key={p.phase} className={`rp rp-${p.state}`} aria-current={p.phase === view.current_phase ? "step" : undefined}>
              <div className="rh"><strong>{p.phase}</strong> <span aria-hidden="true">{PH_ICON[p.state]}</span> <span className="small muted">{PH_STATE[p.state]}</span></div>
              <div className="small">{p.label}</div>
              <div className="small muted num">
                {p.lines ? `${p.merged}/${p.lines} lignes mergées` : "—"}
                {p.blocked ? ` · ${p.blocked} bloquée${p.blocked > 1 ? "s" : ""}` : ""}
              </div>
              <div className="rbar" role="img" aria-label={`Budget ${p.phase} : ${pct(p.budget_pct)}`}>
                <span style={{ width: `${Math.min(100, p.budget_pct * 100)}%` }} className={p.alert_level === "ok" ? "" : "hot"} />
              </div>
              <div className="small muted num">{p.lines ? `${pct(p.budget_pct)} du budget` : ""}</div>
            </li>
          ))}
        </ol>
        <p className="small muted" style={{ marginBottom: 0 }}>Le total prévu de lignes par phase n’est pas connu du flux : le ratio compte les lignes déjà démarrées.</p>
      </section>

      <section className="card" aria-labelledby="h-lines2">
        <h2 id="h-lines2">{cur ? `Lignes en cours · ${cur.phase}` : "Lignes"}</h2>
        {view.lines.length === 0 ? <p className="muted">Aucune ligne ouverte.</p> : (
          <div className="tablewrap">
            <table className="plines">
              <thead><tr><th>Ligne</th><th>Étape</th><th>Agent · modèle</th><th className="r">Essais</th><th className="r">Coût</th><th>État</th></tr></thead>
              <tbody>
                {view.lines.map((l) => {
                  const m = l.model ? modelMeta(l.model) : null;
                  const label = l.muted ? "muette" : l.state === "blocked" ? "bloquée" : l.state === "killed" ? "arrêtée" : "en cours";
                  const icon = l.muted ? "◌" : l.state === "blocked" ? "⏸" : l.state === "killed" ? "■" : "●";
                  const isOpen = open === l.line;
                  return (
                    <FragmentRow key={l.line} open={isOpen} colSpan={6}
                      row={
                        <tr>
                          <td><button className="plain" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : l.line)}><span aria-hidden="true">{isOpen ? "▾" : "▸"}</span> <strong>{l.line}</strong></button></td>
                          <td>
                            <span className="steps" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map((i) => <i key={i} className={i < l.step_index ? "d" : i === l.step_index ? "c" : ""} />)}</span>
                            {" "}<span aria-label={`étape ${l.step_index + 1} sur 6`}>{l.step_label}</span> <span aria-hidden="true">{STEP_ICON[l.step_state]}</span>
                          </td>
                          <td>{l.agent}{m ? <> · <span className="sq sm" style={{ background: m.color }} aria-hidden="true" /> {l.model === "none" ? "code" : m.label}</> : null}</td>
                          <td className="r num">{l.attempts || "—"}</td>
                          <td className="r num">{fmtUsd(l.cost)}</td>
                          <td><span className={`badge st-${l.muted ? "muted" : l.state}`}><span className="ic" aria-hidden="true">{icon}</span>{label}</span></td>
                        </tr>
                      }
                      detail={<LineLoop calls={prod.calls} line={l.line} />} />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="h-watch">
        <h2 id="h-watch">À surveiller ({view.watch.length})</h2>
        {view.watch.length === 0 ? <p className="muted">Rien à signaler.</p> : (
          <ul className="alerts">
            {view.watch.map((w, i) => (
              <li key={w.subject + i} className={`alert ${w.severity}`}>
                <span className="tag"><span aria-hidden="true">{SEV_ICON[w.severity]}</span></span><span>{w.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="card agents-sum">
        <summary>Agents : {view.agents.running} actif{view.agents.running > 1 ? "s" : ""} · {view.agents.muted} muet{view.agents.muted > 1 ? "s" : ""} · {view.agents.blocked} bloqué{view.agents.blocked > 1 ? "s" : ""} · {view.agents.idle} inactif{view.agents.idle > 1 ? "s" : ""}</summary>
        <ul className="small" style={{ paddingLeft: 18 }}>
          {prod.agents.map((a) => (
            <li key={a.agent}><strong>{a.agent}</strong> · {a.state === "idle" ? "inactif" : a.state === "running" ? "actif" : a.state === "muted" ? "muet" : "bloqué"}
              {a.units.length ? ` · ${a.units.map((u) => u.line).join(", ")}` : ""}</li>
          ))}
        </ul>
        <p className="small muted">Détail complet dans l’onglet Production.</p>
      </details>
    </>
  );
}

/** Ligne de tableau + ligne de détail dépliable. */
function FragmentRow({ row, detail, open, colSpan }: { row: React.ReactNode; detail: React.ReactNode; open: boolean; colSpan: number }) {
  return (
    <>
      {row}
      {open && <tr className="detail"><td colSpan={colSpan}>{detail}</td></tr>}
    </>
  );
}

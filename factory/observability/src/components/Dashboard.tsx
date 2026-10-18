"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Summary } from "@/lib/summary";
import type { StoredEvent } from "@/lib/types";
import { MODELS, STATUS, fmtAge, fmtTok, fmtUsd, modelMeta, pct } from "./shared";
import { Production } from "./Production";
import { Project } from "./Project";

type Theme = "auto" | "light" | "dark";
type Tab = "project" | "prod" | "ops";
const TABS: [Tab, string, string][] = [["project", "Projet", "#projet"], ["prod", "Production", "#production"], ["ops", "AI Ops", "#ops"]];
type Line = Summary["lines"][number];
type Tip = { x: number; y: number; model: string; tokens: number; phase: string; share: number };

const STATE: Record<string, { icon: string; label: string; cls: string }> = {
  active: { icon: "●", label: "En cours", cls: "st-active" }, blocked: { icon: "⏸", label: "Bloquée", cls: "st-blocked" },
  killed: { icon: "■", label: "Arrêtée", cls: "st-killed" }, merged: { icon: "✓", label: "Mergée", cls: "st-merged" },
  muted: { icon: "◌", label: "Muette", cls: "st-muted" },
};
const SEV: Record<string, { icon: string; label: string }> = {
  warning: { icon: "▲", label: "Attention" }, serious: { icon: "◆", label: "Sérieux" }, critical: { icon: "⬣", label: "Critique" },
};

const AXIS_MAX = 1.4; // l'axe va de 0 à 140 % du budget

export function Dashboard() {
  const [sum, setSum] = useState<Summary | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [conn, setConn] = useState<"connecting" | "live" | "down">("connecting");
  const [theme, setTheme] = useState<Theme>("auto");
  const [now, setNow] = useState(() => Date.now());
  const [tip, setTip] = useState<Tip | null>(null);
  const [tab, setTab] = useState<Tab>("project");
  const [tick, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/summary", { cache: "no-store" });
      const s: Summary = await r.json();
      setSum(s);
      setTick((t) => t + 1);
      return s;
    } catch { return null; }
  }, []);
  const scheduleRefresh = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => { timer.current = null; void refresh(); }, 400);
  }, [refresh]);

  useEffect(() => {
    const byHash = TABS.find((t) => t[2] === window.location.hash)?.[0] ?? null;
    let saved: string | null = null;
    try { saved = localStorage.getItem("obs-tab"); } catch { /* stockage indisponible */ }
    setTab(byHash ?? TABS.find((t) => t[0] === saved)?.[0] ?? "project");
  }, []);
  const pickTab = (t: Tab) => {
    setTab(t);
    window.history.replaceState(null, "", TABS.find((x) => x[0] === t)![2]);
    try { localStorage.setItem("obs-tab", t); } catch { /* ignore */ }
  };

  useEffect(() => {
    try { const t = localStorage.getItem("obs-theme"); if (t === "light" || t === "dark") { setTheme(t); document.documentElement.dataset.theme = t; } } catch { /* stockage indisponible */ }
  }, []);
  const cycleTheme = () => {
    const next: Theme = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
    setTheme(next);
    if (next === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
    try { next === "auto" ? localStorage.removeItem("obs-theme") : localStorage.setItem("obs-theme", next); } catch { /* ignore */ }
  };

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    (async () => {
      const s = await refresh();
      if (cancelled) return;
      if (s) setEvents(s.recent.slice(0, 80));
      es = new EventSource(`/api/stream?lastEventId=${s?.last_id ?? 0}`);
      es.onopen = () => setConn("live");
      es.onerror = () => setConn(es?.readyState === EventSource.CLOSED ? "down" : "connecting");
      es.addEventListener("event", (m) => {
        const ev: StoredEvent = JSON.parse((m as MessageEvent).data);
        setEvents((prev) => (prev.some((p) => p.id === ev.id) ? prev : [ev, ...prev].slice(0, 80)));
        scheduleRefresh();
      });
    })();
    const iv = setInterval(() => { setNow(Date.now()); }, 5000);
    const iv2 = setInterval(() => { void refresh(); }, 15000);
    return () => { cancelled = true; es?.close(); clearInterval(iv); clearInterval(iv2); };
  }, [refresh, scheduleRefresh]);

  if (!sum) return <main className="wrap"><p className="muted">Chargement…</p></main>;

  const totalTok = sum.by_model.reduce((a, m) => a + Number(m.tokens_total), 0);
  const invPct = (sum.counters.invalid_rate * 100).toFixed(sum.counters.invalid_rate > 0 && sum.counters.invalid_rate < 0.1 ? 1 : 0);
  const idle = (l: Line) => Math.max(l.idle_s, Math.round((now - Date.parse(l.last_ts)) / 1000));

  return (
    <main className="wrap">
      <header className="top">
        <h1>Observabilité de la dark factory</h1>
        <div className="row">
          <span className="pill" role="status" aria-live="polite">
            <span className={`dot ${conn === "live" ? "live" : conn === "down" ? "down" : ""}`} aria-hidden="true" />
            {conn === "live" ? "Flux temps réel actif" : conn === "down" ? "Flux interrompu" : "Connexion…"}
          </span>
          <button onClick={cycleTheme} aria-label={`Thème : ${theme}. Changer`}>Thème : {theme === "auto" ? "auto" : theme === "light" ? "clair" : "sombre"}</button>
        </div>
      </header>

      <div className="tabs" role="tablist" aria-label="Vues du dashboard">
        {TABS.map(([id, label], i) => (
          <button key={id} role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`}
            tabIndex={tab === id ? 0 : -1} className={tab === id ? "on" : ""} onClick={() => pickTab(id)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const n = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length][0];
              pickTab(n);
              document.getElementById(`tab-${n}`)?.focus();
            }}>
            {label}
          </button>
        ))}
      </div>

      {tab === "project" && (
        <div role="tabpanel" id="panel-project" aria-labelledby="tab-project" style={{ display: "grid", gap: 16 }}>
          <Project sum={sum} tick={tick} />
        </div>
      )}

      {tab === "prod" && (
        <div role="tabpanel" id="panel-prod" aria-labelledby="tab-prod" style={{ display: "grid", gap: 16 }}>
          <Production tick={tick} />
        </div>
      )}

      <div role="tabpanel" id="panel-ops" aria-labelledby="tab-ops" hidden={tab !== "ops"} style={{ display: tab === "ops" ? "grid" : "none", gap: 16 }}>
      <section aria-label="Indicateurs" className="tiles">
        <Tile v={sum.line_counts.active} l="Lignes actives" />
        <Tile v={sum.line_counts.blocked + sum.line_counts.killed} l="Bloquées / arrêtées" />
        <Tile v={sum.line_counts.merged} l="Lignes mergées" />
        <Tile v={fmtUsd(sum.totals.cost)} l={`Coût · ${fmtTok(sum.totals.tokens)} tokens`} />
        <Tile v={sum.retries.avg_retries_per_line} l={`Retries / ligne (cible ≤ 1,5) · ${sum.retries.total_loops} boucle(s)`} />
        <Tile v={`${invPct} %`} l={`Événements invalides · ${sum.counters.events_invalid_total} / ${sum.counters.events_received_total}`} />
      </section>

      <section className="card" aria-labelledby="h-alerts">
        <h2 id="h-alerts">Alertes ({sum.alerts.length})</h2>
        {sum.alerts.length === 0 ? <p className="muted">Aucune alerte.</p> : (
          <ul className="alerts">
            {sum.alerts.map((a) => (
              <li key={a.kind + a.subject} className={`alert ${a.severity}`}>
                <span className="tag"><span aria-hidden="true">{SEV[a.severity].icon}</span> {SEV[a.severity].label}</span>
                <span>{a.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="h-lines">
        <h2 id="h-lines">Lignes de production ({sum.lines.length})</h2>
        {sum.lines.length === 0 ? <p className="muted">Aucune ligne. Lancez <code>npm run simulate</code>.</p> : (
          <div className="lines">
            {sum.lines.map((l) => {
              const key = l.muted ? "muted" : l.state;
              const st = STATE[key];
              const ls = STATUS[String(l.last_status)] ?? STATUS.ok;
              return (
                <article key={l.line} className={`line state-${key}`}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="id">{l.line}</span>
                    <span className={`badge ${st.cls}`}><span className="ic" aria-hidden="true">{st.icon}</span>{st.label}</span>
                  </div>
                  <div className="kv"><span>{String(l.phase)} · {String(l.last_agent)}</span><span className="num">il y a {fmtAge(idle(l))}</span></div>
                  <div className="kv"><span>{String(l.last_action)}</span><span className={`badge st-${l.last_status}`}><span className="ic" aria-hidden="true">{ls.icon}</span>{ls.label}</span></div>
                  <div className="kv"><span className="num">{fmtTok(Number(l.tokens_total))} tok · {fmtUsd(Number(l.cost))}</span><span className="num">{String(l.retries)} retry · {String(l.loops)} boucle</span></div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="h-budget">
        <h2 id="h-budget">Tokens consommés vs budget de phase, par modèle</h2>
        <div className="legend" aria-label="Légende des modèles">
          {MODELS.map((m) => {
            const row = sum.by_model.find((x) => x.model === m.id);
            const share = totalTok && row ? Number(row.tokens_total) / totalTok : 0;
            return <span key={m.id} className="small"><span className="key" style={{ background: m.color }} />{m.short} · {m.label} <span className="num muted">{pct(share)}</span></span>;
          })}
        </div>
        {sum.phases.map((p) => (
          <div className="phase" key={p.phase}>
            <strong>{p.phase}</strong>
            <div className="track" role="img" aria-label={`${p.phase} : ${fmtTok(p.consumed_tokens)} tokens, ${pct(p.pct_budget)} du budget de ${fmtTok(p.budget_tokens)}`}>
              <BarSegments p={p} setTip={setTip} />
              <span className="mark" style={{ left: `${(0.8 / AXIS_MAX) * 100}%` }} />
              <span className="mark" style={{ left: `${(1 / AXIS_MAX) * 100}%` }} />
              <span className="mark ceil" style={{ left: `${(1.3 / AXIS_MAX) * 100}%` }} />
            </div>
            <div className="val num">
              {p.alert_level !== "ok" && <strong>{p.alert_level === "ceiling" ? "⬣ plafond " : p.alert_level === "over" ? "◆ dépassé " : "▲ 80 % "}</strong>}
              {fmtTok(p.consumed_tokens)} / {fmtTok(p.budget_tokens)} ({pct(p.pct_budget)})
            </div>
          </div>
        ))}
        <div className="axis" aria-hidden="true">
          <span />
          <div className="scale">
            <span style={{ left: "0%" }}>0</span>
            <span style={{ left: `${(0.8 / AXIS_MAX) * 100}%` }}>alerte 80 %</span>
            <span style={{ left: `${(1 / AXIS_MAX) * 100}%`, top: 12 }}>budget 100 %</span>
            <span style={{ left: `${(1.3 / AXIS_MAX) * 100}%` }}>plafond 130 %</span>
          </div>
          <span />
        </div>
        <details>
          <summary>Vue tableau</summary>
          <div className="tablewrap">
            <table>
              <caption className="small muted" style={{ textAlign: "left" }}>Tokens par phase et modèle (entrée + sortie + cache)</caption>
              <thead><tr><th>Phase</th>{MODELS.map((m) => <th className="r" key={m.id}>{m.short}</th>)}<th className="r">Autres</th><th className="r">Total</th><th className="r">Budget</th><th className="r">% budget</th><th className="r">Coût</th></tr></thead>
              <tbody>
                {sum.phases.map((p) => {
                  const by = (id: string) => p.models.find((m) => m.model === id)?.tokens_total ?? 0;
                  const other = p.consumed_tokens - MODELS.reduce((a, m) => a + by(m.id), 0);
                  return (
                    <tr key={p.phase}><td>{p.phase}</td>{MODELS.map((m) => <td className="r num" key={m.id}>{fmtTok(by(m.id))}</td>)}
                      <td className="r num">{fmtTok(other)}</td><td className="r num">{fmtTok(p.consumed_tokens)}</td><td className="r num">{fmtTok(p.budget_tokens)}</td><td className="r num">{pct(p.pct_budget)}</td><td className="r num">{fmtUsd(p.cost)}</td></tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <div className="cols">
        <section className="card" aria-labelledby="h-tl">
          <h2 id="h-tl">Timeline des événements</h2>
          <ol className="timeline" role="log" aria-label="Derniers événements" aria-live="off">
            {events.map((e) => {
              const st = STATUS[e.status] ?? STATUS.ok;
              const mm = modelMeta(e.model);
              return (
                <li key={e.id}>
                  <span className="num muted">{e.ts.slice(11, 23)}</span>
                  <span>{e.line}</span>
                  <span className="c">{e.agent} · {e.action}{e.attempt ? ` #${e.attempt}` : ""} <span className="muted">· {mm.short !== "·" ? mm.short : "—"}{e.tokens_in + e.tokens_out + (e.tokens_cache_read ?? 0) > 0 ? ` · ${fmtTok(e.tokens_in + e.tokens_out + (e.tokens_cache_read ?? 0) + (e.tokens_cache_write ?? 0))} tok` : ""}</span></span>
                  <span className={`badge st-${e.status}`}><span className="ic" aria-hidden="true">{st.icon}</span>{st.label}</span>
                </li>
              );
            })}
          </ol>
        </section>

        <section className="card" aria-labelledby="h-inv">
          <h2 id="h-inv">Qualité d&apos;ingestion</h2>
          <p><strong className="num">{invPct} %</strong> d&apos;événements invalides <span className="muted num">({sum.counters.events_invalid_total} rejetés / {sum.counters.events_received_total} reçus ; {sum.counters.events_duplicate_total} doublons ignorés)</span></p>
          {sum.recent_invalid.length === 0 ? <p className="muted">Aucun rejet récent.</p> : (
            <ul className="small" style={{ paddingLeft: 18 }}>
              {sum.recent_invalid.map((r, i) => <li key={i}><span className="muted num">{r.received_at.slice(11, 19)}</span> {r.reason}</li>)}
            </ul>
          )}
          <h2 style={{ marginTop: 16 }}>Coût par agent</h2>
          <div className="tablewrap"><table>
            <thead><tr><th>Agent</th><th className="r">Tokens</th><th className="r">Coût</th></tr></thead>
            <tbody>{sum.by_agent.map((a) => <tr key={String(a.agent)}><td>{String(a.agent)}</td><td className="r num">{fmtTok(Number(a.tokens_total))}</td><td className="r num">{fmtUsd(Number(a.cost))}</td></tr>)}</tbody>
          </table></div>
        </section>
      </div>
      </div>

      {tip && (
        <div className="tip" role="tooltip" style={{ left: Math.min(tip.x + 12, typeof window !== "undefined" ? window.innerWidth - 270 : tip.x), top: tip.y + 12 }}>
          <b className="num">{fmtTok(tip.tokens)} tokens</b> <span className="muted">({pct(tip.share)} de {tip.phase})</span><br />
          <span className="muted">{modelMeta(tip.model).label}</span>
        </div>
      )}
    </main>
  );
}

function Tile({ v, l }: { v: string | number; l: string }) {
  return <div className="tile"><div className="v num">{v}</div><div className="l">{l}</div></div>;
}

function BarSegments({ p, setTip }: { p: Summary["phases"][number]; setTip: (t: Tip | null) => void }) {
  let acc = 0;
  const total = p.consumed_tokens || 1;
  return (
    <>
      {p.models.filter((m) => m.tokens_total > 0).map((m) => {
        const w = (m.tokens_total / p.budget_tokens / AXIS_MAX) * 100;
        const left = (acc / p.budget_tokens / AXIS_MAX) * 100;
        acc += m.tokens_total;
        const meta = modelMeta(m.model);
        const show = (x: number, y: number) => setTip({ x, y, model: m.model, tokens: m.tokens_total, phase: p.phase, share: m.tokens_total / total });
        return (
          <span key={m.model} className="seg" tabIndex={0}
            aria-label={`${p.phase}, ${meta.label} : ${fmtTok(m.tokens_total)} tokens`}
            style={{ left: `${left}%`, width: `${w}%`, background: meta.color }}
            onPointerMove={(e) => show(e.clientX, e.clientY)} onPointerLeave={() => setTip(null)}
            onFocus={(e) => { const r = e.currentTarget.getBoundingClientRect(); show(r.left, r.bottom); }} onBlur={() => setTip(null)} />
        );
      })}
    </>
  );
}

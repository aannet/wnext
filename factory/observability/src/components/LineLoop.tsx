"use client";

import { useMemo } from "react";
import type { Call } from "@/lib/flow";
import { buildLineLoop, type StepState } from "@/lib/loop";
import { fmtTok, modelMeta } from "./shared";

const STATE: Record<StepState, { icon: string; label: string; cls: string }> = {
  pending: { icon: "○", label: "à venir", cls: "lp-pending" },
  running: { icon: "●", label: "en cours", cls: "lp-running" },
  done: { icon: "✓", label: "fait", cls: "lp-done" },
  failed: { icon: "✕", label: "échec", cls: "lp-failed" },
  blocked: { icon: "⏸", label: "bloqué", cls: "lp-blocked" },
};
const OUTCOME = { merged: "mergée", killed: "arrêtée", open: "en cours" } as const;

export function LineLoop({ calls, line }: { calls: Call[]; line: string }) {
  const view = useMemo(() => buildLineLoop(calls, line), [calls, line]);
  if (!calls.some((c) => c.line === line)) return <p className="muted">Aucun événement pour la ligne {line}.</p>;
  return (
    <>
      <p className="small muted">
        Ligne <strong>{view.line}</strong> · {OUTCOME[view.outcome]} · {view.retries} retry · {view.escalations} escalade{view.escalations > 1 ? "s" : ""} · {view.loops} boucle{view.loops > 1 ? "s" : ""}
      </p>
      <ol className="loop" aria-label={`Étapes de la ligne ${view.line}`}>
        {view.steps.map((s, i) => {
          const st = STATE[s.state];
          const m = s.model ? modelMeta(s.model) : null;
          return (
            <li key={s.id} className={`step ${st.cls}`}>
              <div className="sh"><span className="sn num">{i + 1}</span><strong>{s.label}</strong></div>
              <div className="small">{s.agent}</div>
              <div className="badge"><span className="ic" aria-hidden="true">{st.icon}</span>{st.label}</div>
              <div className="small muted">
                {m ? (
                  <><span className="sq sm" style={{ background: m.color }} aria-hidden="true" /> {s.model === "none" ? "code" : m.label}</>
                ) : "—"}
              </div>
              <div className="small muted num">{s.calls ? `${s.attempts} essai${s.attempts > 1 ? "s" : ""} · ${s.calls} appel${s.calls > 1 ? "s" : ""}` : "—"}</div>
              <div className="small muted num">{s.tokens ? `${fmtTok(s.tokens)} tok` : "—"}</div>
            </li>
          );
        })}
      </ol>
    </>
  );
}

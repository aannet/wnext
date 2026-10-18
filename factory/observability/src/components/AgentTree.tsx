"use client";

import { useState } from "react";
import type { Instances, InstanceNode } from "@/lib/instances";
import { Square } from "./Production";
import { fmtAge, fmtTok, fmtUsd, modelMeta } from "./shared";

const STATE_LABEL = { running: "actif", muted: "muet", blocked: "bloqué", done: "terminé", killed: "arrêté" } as const;
const sqState = (s: InstanceNode["state"]) => (s === "running" ? "running" : s === "muted" ? "muted" : s === "blocked" ? "blocked" : undefined);

function Node({ n, depth, showDone }: { n: InstanceNode; depth: number; showDone: boolean }) {
  const kids = showDone ? n.children : n.children.filter((c) => c.state !== "done" && c.state !== "killed" || c.descendants > 0);
  const ended = n.state === "done" || n.state === "killed";
  const label = `${n.agent}${n.subagent_type ? ` · ${n.subagent_type}` : ""}`;
  const title = `${n.instance_id} · ${n.line} · ${modelMeta(n.model).label} · ${STATE_LABEL[n.state]}`;
  return (
    <li>
      <div className={`tn tn-${n.state}`} style={{ paddingLeft: depth * 18 }}>
        <Square model={n.model} state={sqState(n.state)} title={title} />
        <span className="tname">{label}</span>
        <span className="small muted">{depth === 0 ? "orchestrateur" : "sous-agent"} · {n.line}</span>
        <span className="small">{ended ? (n.state === "killed" ? "■ arrêté" : "✓ terminé") : `${STATE_LABEL[n.state]} · il y a ${fmtAge(n.idle_s)}`}</span>
        <span className="small num muted" title="Cet agent / avec ses descendants">
          {fmtTok(n.tokens)} · {fmtUsd(n.cost)}{n.descendants > 0 && ` (arbre ${fmtTok(n.tree_tokens)} · ${fmtUsd(n.tree_cost)})`}
        </span>
      </div>
      {kids.length > 0 && <ul className="tree">{kids.map((c) => <Node key={c.instance_id} n={c} depth={depth + 1} showDone={showDone} />)}</ul>}
    </li>
  );
}

export function AgentTree({ data }: { data: Instances }) {
  const [showDone, setShowDone] = useState(false);
  if (data.counts.total === 0) {
    return <p className="small muted">Aucune instance. Les événements portent <code>instance_id</code> / <code>parent_instance_id</code> pour y apparaître.</p>;
  }
  const roots = showDone ? data.roots : data.roots.filter((r) => r.state !== "done" && r.state !== "killed" || r.children.some((c) => c.state !== "done" && c.state !== "killed"));
  return (
    <>
      <p className="small muted" role="status" aria-live="polite">
        {data.counts.total} instance{data.counts.total > 1 ? "s" : ""} · {data.counts.active} en cours · {data.counts.done} terminée{data.counts.done > 1 ? "s" : ""} · {data.counts.roots} orchestrateur{data.counts.roots > 1 ? "s" : ""}/racine{data.counts.roots > 1 ? "s" : ""} · profondeur {data.counts.max_depth}
        {" "}<label><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> afficher les terminés</label>
      </p>
      {roots.length === 0 ? <p className="small muted">Tout est terminé.</p> : <ul className="tree root">{roots.map((r) => <Node key={r.instance_id} n={r} depth={0} showDone={showDone} />)}</ul>}
    </>
  );
}

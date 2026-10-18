import type { Store } from "./store";

/**
 * Arbre des agents lancés : une instance = une session (orchestrateur, agent ou sous-agent) identifiée par
 * `instance_id` ; `parent_instance_id` pointe l'instance qui l'a lancée. Convention : `agent.start` ouvre une
 * instance, `agent.stop` (ou un statut `killed`) la ferme.
 */
export type InstanceState = "running" | "muted" | "blocked" | "done" | "killed";

export interface InstanceNode {
  instance_id: string;
  parent_id: string | null;
  agent: string; model: string; line: string; phase: string; run_id: string;
  /** Libellé libre du type de sous-agent (detail.subagent_type de l'événement agent.start). */
  subagent_type: string | null;
  state: InstanceState;
  started_ts: string; last_ts: string; last_action: string; last_status: string; idle_s: number;
  events: number; tokens: number; cost: number;
  /** Tokens et coût du sous-arbre (soi + descendants). */
  tree_tokens: number; tree_cost: number; descendants: number;
  children: InstanceNode[];
}

export interface Instances {
  roots: InstanceNode[];
  counts: { total: number; active: number; done: number; roots: number; max_depth: number };
}

interface Row {
  instance_id: string; parent_instance_id: string | null; agent: string; model: string; line: string; phase: string; run_id: string;
  first_ts: string; last_ts: string; events: number; tokens: number; cost: number;
  last_action: string; last_status: string; subagent_type: string | null; stopped: number; killed: number;
}

const MAX_INSTANCES = 500;

export function buildInstances(
  store: Store,
  opts: { phase?: string | null; line?: string | null; now?: Date; muteAfterS?: number } = {},
): Instances {
  const now = opts.now ?? new Date();
  const muteAfterS = opts.muteAfterS ?? Number(process.env.OBS_MUTE_AFTER_S ?? 300);
  const rows = store.db.prepare(
    `WITH g AS (
       SELECT instance_id, MIN(parent_instance_id) AS parent_instance_id, MIN(ts) AS first_ts, MAX(ts) AS last_ts,
              COUNT(*) AS events, SUM(tokens_in + tokens_out + COALESCE(tokens_cache_read,0) + COALESCE(tokens_cache_write,0)) AS tokens,
              ROUND(SUM(cost), 6) AS cost, MAX(action = 'agent.stop') AS stopped, MAX(status = 'killed' OR action = 'kill.triggered') AS killed,
              MAX(CASE WHEN action = 'agent.start' THEN json_extract(detail, '$.subagent_type') END) AS subagent_type
       FROM events
       WHERE instance_id <> '' AND (? IS NULL OR phase = ?) AND (? IS NULL OR line = ?)
       GROUP BY instance_id)
     SELECT g.*, l.agent, l.model, l.line, l.phase, l.run_id, l.action AS last_action, l.status AS last_status
     FROM g JOIN events l ON l.id = (SELECT x.id FROM events x WHERE x.instance_id = g.instance_id ORDER BY x.ts DESC, x.id DESC LIMIT 1)
     ORDER BY g.first_ts DESC LIMIT ?`,
  ).all(opts.phase ?? null, opts.phase ?? null, opts.line ?? null, opts.line ?? null, MAX_INSTANCES) as Row[];

  const nodes = new Map<string, InstanceNode>();
  for (const r of rows) {
    const idle_s = Math.max(0, Math.round((now.getTime() - Date.parse(r.last_ts)) / 1000));
    const blocked = r.last_status === "blocked" || r.last_status === "looping" || r.last_action === "loop.detected";
    const state: InstanceState = r.killed ? "killed" : r.stopped ? "done" : blocked ? "blocked" : idle_s > muteAfterS ? "muted" : "running";
    nodes.set(r.instance_id, {
      instance_id: r.instance_id, parent_id: r.parent_instance_id, agent: r.agent, model: r.model, line: r.line, phase: r.phase, run_id: r.run_id,
      subagent_type: r.subagent_type, state, started_ts: r.first_ts, last_ts: r.last_ts, last_action: r.last_action, last_status: r.last_status, idle_s,
      events: r.events, tokens: r.tokens, cost: r.cost, tree_tokens: r.tokens, tree_cost: r.cost, descendants: 0, children: [],
    });
  }

  // Rattachement ; un parent inconnu (hors filtre, hors limite) ou un cycle fait de l'instance une racine.
  const roots: InstanceNode[] = [];
  const reaches = (from: InstanceNode, target: string) => {
    for (let n: InstanceNode | undefined = from, i = 0; n && i < nodes.size; n = n.parent_id ? nodes.get(n.parent_id) : undefined, i++) if (n.instance_id === target) return true;
    return false;
  };
  for (const n of nodes.values()) {
    const parent = n.parent_id && n.parent_id !== n.instance_id ? nodes.get(n.parent_id) : undefined;
    if (parent && !reaches(parent, n.instance_id)) parent.children.push(n);
    else roots.push(n);
  }

  let maxDepth = 0;
  const walk = (n: InstanceNode, depth: number) => {
    maxDepth = Math.max(maxDepth, depth);
    n.children.sort((a, b) => a.started_ts.localeCompare(b.started_ts));
    for (const c of n.children) {
      walk(c, depth + 1);
      n.tree_tokens += c.tree_tokens; n.tree_cost += c.tree_cost; n.descendants += 1 + c.descendants;
    }
    n.tree_cost = Math.round(n.tree_cost * 1e6) / 1e6;
  };
  roots.sort((a, b) => b.started_ts.localeCompare(a.started_ts));
  for (const r of roots) walk(r, 0);

  const all = [...nodes.values()];
  return {
    roots,
    counts: {
      total: all.length, roots: roots.length, max_depth: maxDepth,
      active: all.filter((n) => n.state === "running" || n.state === "blocked" || n.state === "muted").length,
      done: all.filter((n) => n.state === "done" || n.state === "killed").length,
    },
  };
}

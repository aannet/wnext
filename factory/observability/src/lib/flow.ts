import type { StoredEvent } from "./types";

/**
 * Causalité déduite du flux (strategy.md §4.1) : dans un même run, quand l'agent change d'un événement
 * au suivant, le précédent est « l'appelant » du nouveau. Le type de lien vient de l'action du nouvel événement.
 */
export type EdgeKind = "handoff" | "retry" | "escalate" | "loop" | "kill";

export interface Call {
  id: number; ts: string; start_ms: number; end_ms: number; duration_ms: number;
  line: string; phase: string; run_id: string;
  agent: string; model: string; action: string; status: string; attempt?: number;
  /** Tokens de l'événement : entrée + sortie + cache (même définition que le store). */
  tokens: number;
  /** Agent appelant (celui du dernier changement d'agent dans le run), null pour le premier événement. */
  caller: string | null;
  /** Type de lien si l'agent a changé à cet événement, sinon « call » (même agent qui continue). */
  kind: EdgeKind | "call";
  prev_id: number | null;
}

export interface FlowEdge { from: string; to: string; kind: EdgeKind; count: number; lines: number; last_ts: string }

export function kindOf(e: Pick<StoredEvent, "action" | "status">): EdgeKind {
  if (e.action.startsWith("kill.") || e.status === "killed") return "kill";
  if (e.action === "loop.detected" || e.status === "looping") return "loop";
  if (e.action.startsWith("escalate.") || e.status === "escalated") return "escalate";
  if (e.action.startsWith("retry.") || e.status === "retry") return "retry";
  return "handoff";
}

export function inferFlow(events: StoredEvent[]): { calls: Call[]; edges: FlowEdge[] } {
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id));
  const runs = new Map<string, { prev: StoredEvent; caller: string | null }>();
  const edges = new Map<string, FlowEdge & { set: Set<string> }>();
  const calls: Call[] = [];

  for (const e of sorted) {
    const key = `${e.line}|${e.run_id}`;
    const st = runs.get(key);
    let caller = st?.caller ?? null;
    let kind: Call["kind"] = "call";
    if (st && st.prev.agent !== e.agent) {
      caller = st.prev.agent;
      kind = kindOf(e);
      const ek = `${caller}>${e.agent}>${kind}`;
      const edge = edges.get(ek) ?? { from: caller, to: e.agent, kind, count: 0, lines: 0, last_ts: e.ts, set: new Set<string>() };
      edge.count++;
      edge.set.add(e.line);
      edge.last_ts = e.ts;
      edges.set(ek, edge);
    }
    const end = Date.parse(e.ts);
    calls.push({
      id: e.id, ts: e.ts, start_ms: end - e.duration_ms, end_ms: end, duration_ms: e.duration_ms,
      line: e.line, phase: e.phase, run_id: e.run_id, agent: e.agent, model: e.model, action: e.action, status: e.status,
      attempt: e.attempt,
      tokens: e.tokens_in + e.tokens_out + (e.tokens_cache_read ?? 0) + (e.tokens_cache_write ?? 0), caller, kind, prev_id: st?.prev.id ?? null,
    });
    runs.set(key, { prev: e, caller });
  }

  return {
    calls,
    edges: [...edges.values()].map(({ set, ...edge }) => ({ ...edge, lines: set.size })).sort((a, b) => b.count - a.count),
  };
}

import { rowToEvent, type Store } from "./store";
import { inferFlow, type Call, type FlowEdge } from "./flow";
import { AGENTS, PHASES, type StoredEvent } from "./types";

export type UnitState = "running" | "muted" | "blocked";

/** Un carré du dashboard : une ligne de production sollicitant un agent. */
export interface Unit { agent: string; line: string; phase: string; model: string; state: UnitState; action: string; status: string; idle_s: number }
export interface AgentNow {
  agent: string;
  state: UnitState | "idle";
  units: Unit[];
  last_ts: string | null; last_model: string | null; last_action: string | null; idle_s: number | null;
}
export interface MatrixLine { line: string; model: string; events: number; tokens: number; errors: number }
export interface MatrixCell { phase: string; agent: string; events: number; lines: MatrixLine[] }
export interface PhaseStatus { phase: string; lines: number; open: number; state: "empty" | "open" | "done" }

export interface Production {
  generated_at: string;
  filter: { phase: string | null; line: string | null };
  lines: { line: string; phase: string }[];
  agents: AgentNow[];
  counts: { running: number; muted: number; blocked: number };
  phases: PhaseStatus[];
  matrix: MatrixCell[];
  edges: FlowEdge[];
  calls: Call[];
}

interface LineLast { line: string; phase: string; agent: string; model: string; action: string; status: string; ts: string }

const TERMINAL = (r: { action: string; status: string }) => r.action === "merge.done" || r.status === "killed" || r.action === "kill.triggered";
const BLOCKED = (r: { action: string; status: string }) => r.status === "blocked" || r.status === "looping" || r.action === "loop.detected";

export function buildProduction(
  store: Store,
  opts: { phase?: string | null; line?: string | null; now?: Date; muteAfterS?: number; activeWindowS?: number; limit?: number } = {},
): Production {
  const now = opts.now ?? new Date();
  const muteAfterS = opts.muteAfterS ?? Number(process.env.OBS_MUTE_AFTER_S ?? 300);
  const activeWindowS = opts.activeWindowS ?? Number(process.env.OBS_ACTIVE_WINDOW_S ?? 120);
  const phase = opts.phase && (PHASES as readonly string[]).includes(opts.phase) ? opts.phase : null;
  const line = opts.line && /^(P[0-5]-\d{3}|_phase|_global)$/.test(opts.line) ? opts.line : null;
  const idle = (ts: string) => Math.max(0, Math.round((now.getTime() - Date.parse(ts)) / 1000));
  const q = <T>(sql: string, ...params: unknown[]) => store.db.prepare(sql).all(...params) as T[];
  const keep = (r: { phase: string; line: string }) => (!phase || r.phase === phase) && (!line || r.line === line);

  // Dernier événement par ligne -> état de la ligne et agent qui « tient » la ligne.
  const lineLast = q<LineLast>(
    `SELECT line, phase, agent, model, action, status, ts FROM (
       SELECT line, phase, agent, model, action, status, ts,
              ROW_NUMBER() OVER (PARTITION BY line ORDER BY ts DESC, id DESC) AS rn
       FROM events WHERE line NOT IN ('_phase','_global')) WHERE rn = 1 ORDER BY line`,
  );

  // Carrés : (a) l'agent qui tient une ligne non terminée ; (b) tout agent actif dans la fenêtre récente.
  const units = new Map<string, Unit>();
  const unitKey = (agent: string, l: string) => `${agent}|${l}`;
  for (const r of lineLast.filter(keep)) {
    if (TERMINAL(r)) continue;
    const idle_s = idle(r.ts);
    const state: UnitState = BLOCKED(r) ? "blocked" : idle_s > muteAfterS ? "muted" : "running";
    units.set(unitKey(r.agent, r.line), { agent: r.agent, line: r.line, phase: r.phase, model: r.model, state, action: r.action, status: r.status, idle_s });
  }
  const cutoff = new Date(now.getTime() - activeWindowS * 1000).toISOString();
  const recent = q<LineLast>(
    "SELECT line, phase, agent, model, action, status, ts FROM events WHERE ts >= ? AND ts <= ? ORDER BY ts ASC, id ASC",
    cutoff, now.toISOString(),
  ).filter(keep);
  for (const r of recent) {
    const k = unitKey(r.agent, r.line);
    const held = units.get(k);
    if (held && held.state !== "running" && held.idle_s <= idle(r.ts)) continue; // la ligne tenue prime
    units.set(k, { agent: r.agent, line: r.line, phase: r.phase, model: r.model, state: BLOCKED(r) ? "blocked" : "running", action: r.action, status: r.status, idle_s: idle(r.ts) });
  }

  const lastByAgent = new Map(
    q<{ agent: string; model: string; action: string; ts: string }>(
      `SELECT agent, model, action, ts FROM (
         SELECT agent, model, action, ts, ROW_NUMBER() OVER (PARTITION BY agent ORDER BY ts DESC, id DESC) AS rn FROM events) WHERE rn = 1`,
    ).map((r) => [r.agent, r]),
  );
  const rank: Record<UnitState, number> = { blocked: 0, running: 1, muted: 2 };
  const agents: AgentNow[] = AGENTS.map((agent) => {
    const us = [...units.values()].filter((u) => u.agent === agent)
      .sort((a, b) => rank[a.state] - rank[b.state] || a.line.localeCompare(b.line));
    const last = lastByAgent.get(agent);
    const state: AgentNow["state"] = us.length ? (us.some((u) => u.state === "blocked") ? "blocked" : us.some((u) => u.state === "running") ? "running" : "muted") : "idle";
    return { agent, state, units: us, last_ts: last?.ts ?? null, last_model: last?.model ?? null, last_action: last?.action ?? null, idle_s: last ? idle(last.ts) : null };
  });
  const counts = {
    running: agents.filter((a) => a.state === "running").length,
    muted: agents.filter((a) => a.state === "muted").length,
    blocked: agents.filter((a) => a.state === "blocked").length,
  };

  // Matrice phase x agent (non filtrée : c'est elle qui sert de sélecteur).
  const raw = q<{ phase: string; agent: string; line: string; model: string; events: number; tokens_total: number; errors: number }>(
    "SELECT phase, agent, line, model, events, tokens_total, errors FROM v_phase_agent_line",
  );
  const cells = new Map<string, MatrixCell & { byLine: Map<string, Map<string, MatrixLine>> }>();
  for (const r of raw) {
    const k = `${r.phase}|${r.agent}`;
    const c = cells.get(k) ?? { phase: r.phase, agent: r.agent, events: 0, lines: [], byLine: new Map() };
    c.events += r.events;
    const perModel = c.byLine.get(r.line) ?? new Map<string, MatrixLine>();
    perModel.set(r.model, { line: r.line, model: r.model, events: r.events, tokens: r.tokens_total, errors: r.errors });
    c.byLine.set(r.line, perModel);
    cells.set(k, c);
  }
  const matrix: MatrixCell[] = [...cells.values()].map(({ byLine, ...c }) => ({
    ...c,
    // modèle dominant par ligne : le plus de tokens, puis le plus d'événements
    lines: [...byLine.entries()].map(([l, perModel]) => {
      const ms = [...perModel.values()];
      const dom = [...ms].sort((a, b) => b.tokens - a.tokens || b.events - a.events)[0];
      return { line: l, model: dom.model, events: ms.reduce((a, m) => a + m.events, 0), tokens: ms.reduce((a, m) => a + m.tokens, 0), errors: ms.reduce((a, m) => a + m.errors, 0) };
    }).sort((a, b) => a.line.localeCompare(b.line)),
  }));

  const phases: PhaseStatus[] = PHASES.map((p) => {
    const ls = lineLast.filter((r) => r.phase === p);
    const open = ls.filter((r) => !TERMINAL(r)).length;
    return { phase: p, lines: ls.length, open, state: !ls.length ? "empty" : open ? "open" : "done" };
  });

  // Flux et timeline : événements filtrés, les plus récents (bornés).
  const rows = q<Record<string, unknown>>(
    `SELECT * FROM events WHERE (? IS NULL OR phase = ?) AND (? IS NULL OR line = ?) ORDER BY id DESC LIMIT ?`,
    phase, phase, line, line, opts.limit ?? 2000,
  );
  const events = rows.map((r) => rowToEvent(r as never)) as StoredEvent[];
  const { calls, edges } = inferFlow(events);

  const lineOpts = lineLast.map((r) => ({ line: r.line, phase: r.phase }));
  return { generated_at: now.toISOString(), filter: { phase, line }, lines: lineOpts, agents, counts, phases, matrix, edges, calls };
}

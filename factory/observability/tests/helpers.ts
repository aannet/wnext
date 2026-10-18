import { Store } from "@/lib/store";
import { loadBudgets } from "@/lib/config";
import { ulid } from "@/lib/ulid";
import type { FactoryEvent } from "@/lib/types";

export const RUN = ulid(1760000000000, () => 0.5);

export function ev(over: Partial<FactoryEvent> = {}): FactoryEvent {
  return {
    ts: "2026-10-18T09:14:03.221Z", run_id: RUN, line: "P1-017", phase: "P1", agent: "implementeur",
    model: "claude-sonnet-5-5", action: "llm.call", tokens_in: 18420, tokens_out: 2310, cost: 0.05,
    duration_ms: 14250, status: "ok", attempt: 2, ...over,
  };
}

/** Série d'événements aux ts distincts. */
export function evs(n: number, over: Partial<FactoryEvent> = {}): FactoryEvent[] {
  return Array.from({ length: n }, (_, i) =>
    ev({ ts: new Date(Date.UTC(2026, 9, 18, 9, 0, 0, i)).toISOString(), ...over }));
}

export const memStore = () => new Store(":memory:", loadBudgets("config/budgets.json"));

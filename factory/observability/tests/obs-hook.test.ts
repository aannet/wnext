import { describe, expect, it } from "vitest";
import { buildEvent, costOf, sumTranscript, ulidFrom } from "../hooks/obs-hook.mjs";
import { validateEvent } from "@/lib/validate";
import { buildProduction } from "@/lib/production";
import { memStore } from "./helpers";

const SID = "67e53827-c6f4-4b5b-bcc7-dae1b837ee8a";
const NOW = new Date("2026-10-18T09:00:00.000Z");
const PRICES = { "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125] };
const msg = (id: string, out: number) => JSON.stringify({ type: "assistant", message: { id, model: "claude-haiku-5-5", usage: { input_tokens: 2, output_tokens: out, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 } } });
const env = { OBS_LINE: "P0-007", OBS_PHASE: "P0", OBS_AGENT: "implementeur", OBS_PARENT_INSTANCE: "orch-1" };
const build = (p: Record<string, unknown>, files: Record<string, string> = {}) =>
  buildEvent({ session_id: SID, ...p }, env, { now: NOW, prices: PRICES, readFile: (f) => files[f] ?? null })!;

describe("hook d'observabilité", () => {
  it("dédoublonne les messages du transcript et chiffre le coût", () => {
    const t = sumTranscript([msg("a", 10), msg("a", 10), msg("b", 20), "pas du json"].join("\n"));
    expect(t).toMatchObject({ tokens_in: 4, tokens_out: 30, tokens_cache_read: 2000, tokens_cache_write: 200, model: "claude-haiku-5-5" });
    expect(costOf("claude-haiku-5-5", t, PRICES)).toBeCloseTo((4 * 0.1 + 30 * 0.5 + 2000 * 0.01 + 200 * 0.125) / 1e6, 6);
    expect(costOf("inconnu", t, PRICES)).toBe(0);
  });

  it("session : racine ou enfant de l'orchestrateur, sous-agent enfant de la session", () => {
    expect(build({ hook_event_name: "SessionStart", source: "startup" })).toMatchObject({ action: "agent.start", instance_id: SID, parent_instance_id: "orch-1", line: "P0-007" });
    expect(build({ hook_event_name: "SubagentStart", agent_id: "a17", agent_type: "Explore" })).toMatchObject({ instance_id: "a17", parent_instance_id: SID, detail: { subagent_type: "Explore" } });
    expect(build({ hook_event_name: "PostToolUse", agent_id: "a17", tool_name: "Read", duration_ms: 12 })).toMatchObject({ action: "tool.exec", instance_id: "a17", duration_ms: 12 });
    expect(build({ hook_event_name: "PostToolUse", tool_name: "Agent", duration_ms: 3 })).toMatchObject({ instance_id: SID });
  });

  it("agent.stop porte les tokens du transcript ; sans transcript il reste à zéro", () => {
    const e = build({ hook_event_name: "SubagentStop", agent_id: "a17", agent_type: "Explore", agent_transcript_path: "/t" }, { "/t": msg("a", 54) });
    expect(e).toMatchObject({ action: "agent.stop", model: "claude-haiku-5-5", tokens_out: 54, tokens_cache_read: 1000 });
    expect(build({ hook_event_name: "SessionEnd", transcript_path: "/absent" })).toMatchObject({ tokens_out: 0, cost: 0 });
  });

  it("ignore les hooks hors périmètre et dérive un run_id valide sans contexte", () => {
    expect(build({ hook_event_name: "Stop" })).toBeNull();
    const bare = buildEvent({ session_id: SID, hook_event_name: "SessionStart" }, {}, { now: NOW })!;
    expect(bare).toMatchObject({ line: "_global", phase: "P0", run_id: ulidFrom(SID) });
    expect(bare.parent_instance_id).toBeUndefined();
  });

  it("produit des événements valides qui forment l'arbre session -> sous-agent", () => {
    const evs = [
      build({ hook_event_name: "SessionStart" }),
      build({ hook_event_name: "SubagentStart", agent_id: "a17", agent_type: "Explore" }),
      build({ hook_event_name: "PostToolUse", agent_id: "a17", tool_name: "Read", duration_ms: 5 }),
      build({ hook_event_name: "SubagentStop", agent_id: "a17", agent_type: "Explore", agent_transcript_path: "/t" }, { "/t": msg("a", 54) }),
    ];
    for (const e of evs) expect(validateEvent(e)).toEqual({ ok: true, event: e });
    const s = memStore();
    s.ingest(evs);
    const { instances } = buildProduction(s, { now: NOW });
    expect(instances.roots[0].children.map((c) => [c.instance_id, c.state, c.subagent_type])).toEqual([["a17", "done", "Explore"]]);
    expect(instances.roots[0].parent_id).toBe("orch-1");
  });
});

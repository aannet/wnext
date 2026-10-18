import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/clock";
import { FakeRunner, type AgentSpec, type FakeScript } from "../src/runner";
import type { FactoryEvent } from "../src/types";

const spec = (over: Partial<AgentSpec> = {}): AgentSpec => ({
  instance_id: "impl-1", run_id: "01JAB0000000000000000000AB", line: "P0-001", phase: "P0",
  role: "implementeur", model: "claude-sonnet-5-5", prompt: "x", worktree: "/work/w",
  allowed_tools: ["Edit"], limits: { max_tokens: 1_000_000, max_wall_ms: 3 * 3600_000 }, ...over,
});

async function collect(it: AsyncIterable<FactoryEvent>, into: FactoryEvent[]) { for await (const e of it) into.push(e); }

const script: FakeScript = {
  steps: [
    { after_ms: 1000, event: { action: "llm.call", status: "ok", tokens_in: 100, tokens_out: 10, cost: 0.01 } },
    { after_ms: 4000, event: { action: "git.commit", status: "ok" } },
  ],
  end: { after_ms: 500, reason: "completed" },
};

describe("FakeRunner", () => {
  it("joue le script en respectant la Clock injectée", async () => {
    const clock = new ManualClock();
    const t0 = clock.now();
    const runner = new FakeRunner(clock, script);
    const h = runner.start(spec());
    const got: FactoryEvent[] = [];
    const done = collect(h.events, got);
    await clock.advance(999);
    expect(got).toHaveLength(0);
    await clock.advance(1);
    expect(got.map((e) => e.action)).toEqual(["llm.call"]);
    expect(got[0]!.ts).toBe(new Date(t0 + 1000).toISOString());
    await clock.advance(4000);
    expect(got.map((e) => e.action)).toEqual(["llm.call", "git.commit"]);
    expect(got[1]!.ts).toBe(new Date(t0 + 5000).toISOString());
    await clock.advance(500);
    await done;
    const r = await h.result;
    expect(r.end_reason).toBe("completed");
    expect(r.usage).toMatchObject({ tokens_in: 100, tokens_out: 10, cost_usd: 0.01 });
    expect(r.num_turns).toBe(1);
    expect(r.duration_ms).toBe(5500);
    expect(got[0]).toMatchObject({ agent: "implementeur", model: "claude-sonnet-5-5", line: "P0-001", instance_id: "impl-1" });
  });

  it("stop(hard) interrompt un agent qui ne se termine pas seul", async () => {
    const clock = new ManualClock();
    const runner = new FakeRunner(clock, { steps: [{ after_ms: 1000, event: { action: "tool.exec", status: "ok" } }] });
    const h = runner.start(spec());
    const got: FactoryEvent[] = [];
    const done = collect(h.events, got);
    await clock.advance(1000);
    await clock.advance(10 * 60_000);
    expect(got).toHaveLength(1);
    await h.stop("hard");
    await done;
    expect((await h.result).end_reason).toBe("stopped_hard");
    expect(runner.stops).toEqual([{ instance_id: "impl-1", mode: "hard" }]);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("stop(soft) pendant un délai n'émet plus d'événement", async () => {
    const clock = new ManualClock();
    const runner = new FakeRunner(clock, script);
    const h = runner.start(spec());
    const got: FactoryEvent[] = [];
    const done = collect(h.events, got);
    await clock.advance(1000);
    await h.stop("soft");
    await clock.advance(60_000);
    await done;
    expect(got).toHaveLength(1);
    expect((await h.result).end_reason).toBe("stopped_soft");
  });

  it("applique la limite de durée murale de la spec", async () => {
    const clock = new ManualClock();
    const runner = new FakeRunner(clock, { steps: [] });
    const h = runner.start(spec({ limits: { max_tokens: 1e6, max_wall_ms: 60_000 } }));
    await clock.advance(60_000);
    expect((await h.result).end_reason).toBe("limit_wall");
  });

  it("applique la limite de tokens", async () => {
    const clock = new ManualClock();
    const runner = new FakeRunner(clock, script);
    const h = runner.start(spec({ limits: { max_tokens: 50, max_wall_ms: 1e9 } }));
    await clock.advance(1000);
    expect((await h.result).end_reason).toBe("limit_tokens");
  });

  it("choisit le script par rôle, refuse si kill-switch actif, enregistre les specs", async () => {
    const clock = new ManualClock();
    const runner = new FakeRunner(clock, { implementeur: script });
    expect(() => runner.start(spec({ role: "testeur" }))).toThrow(/aucun script/);
    runner.killSwitchActive = true;
    expect(() => runner.start(spec())).toThrow(/kill-switch/);
    runner.killSwitchActive = false;
    runner.start(spec());
    expect(runner.started).toHaveLength(1);
    await clock.advance(10_000);
  });
});

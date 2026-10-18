import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as stream } from "@/app/api/stream/route";
import { POST as post } from "@/app/api/events/route";
import { GET as summary } from "@/app/api/summary/route";
import { getStore, resetStoreForTests } from "@/lib/store";
import { ev, evs } from "./helpers";

async function readEvents(res: Response, n: number, timeoutMs = 2000) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: { id: string; data: any }[] = [];
  const deadline = Date.now() + timeoutMs;
  while (out.length < n && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 100))]);
    if (r && !r.done) buf += dec.decode(r.value);
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const id = /^id: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (id && data) out.push({ id, data: JSON.parse(data) });
    }
  }
  await reader.cancel();
  return out;
}

const postJsonl = (events: unknown[]) =>
  post(new Request("http://x/api/events", { method: "POST", headers: { "content-type": "application/x-ndjson" }, body: events.map((e) => JSON.stringify(e)).join("\n") }));

beforeEach(() => { process.env.OBS_DB_PATH = ":memory:"; resetStoreForTests(); });
afterEach(() => resetStoreForTests());

describe("SSE /api/stream", () => {
  it("diffuse en direct les événements ingérés, avec id croissants", async () => {
    const res = await stream(new Request("http://x/api/stream"));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const pending = readEvents(res, 3);
    await postJsonl(evs(3));
    const got = await pending;
    expect(got.map((g) => Number(g.id))).toEqual([1, 2, 3]);
    expect(got[0].data.line).toBe("P1-017");
  });
  it("reprend via Last-Event-ID sans trou ni doublon", async () => {
    await postJsonl(evs(5));
    const res = await stream(new Request("http://x/api/stream", { headers: { "last-event-id": "2" } }));
    const pending = readEvents(res, 4);
    await postJsonl([ev({ ts: "2026-10-18T10:00:00.000Z" })]);
    const got = await pending;
    expect(got.map((g) => Number(g.id))).toEqual([3, 4, 5, 6]);
  });
  it("ne rediffuse pas un doublon ingéré", async () => {
    const res = await stream(new Request("http://x/api/stream"));
    const pending = readEvents(res, 2, 800);
    await postJsonl([ev(), ev()]);
    expect((await pending).length).toBe(1);
  });
  it("sans Last-Event-ID, ne rejoue pas l'historique", async () => {
    await postJsonl(evs(2));
    const res = await stream(new Request("http://x/api/stream"));
    expect((await readEvents(res, 1, 500)).length).toBe(0);
  });
});

describe("API", () => {
  it("POST /api/events : 400 si tout est invalide, 200 + comptage sinon", async () => {
    const bad = await postJsonl([{ x: 1 }]);
    expect(bad.status).toBe(400);
    const mixed = await postJsonl([ev(), { x: 1 }]);
    expect(mixed.status).toBe(200);
    expect(await mixed.json()).toMatchObject({ accepted: 1, invalid: 1 });
  });
  it("GET /api/summary est cohérent avec le store", async () => {
    await postJsonl([...evs(3, { tokens_in: 1000, tokens_out: 0, cost: 0.5 }), { bad: true }]);
    const s = await (await summary()).json();
    expect(s.totals).toMatchObject({ events: 3, tokens: 3000, cost: 1.5 });
    expect(s.counters.events_invalid_total).toBe(1);
    expect(s.last_id).toBe(getStore().lastId());
    expect(s.phases.find((p: any) => p.phase === "P1").consumed_tokens).toBe(3000);
  });
});

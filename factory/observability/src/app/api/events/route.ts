import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { ingestBody, MAX_BODY_BYTES } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/events : un événement JSON, un tableau JSON ou un lot JSONL (application/x-ndjson ou text/plain). */
export async function POST(req: Request) {
  const body = await req.text();
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "corps trop volumineux" }, { status: 413 });
  }
  const res = ingestBody(getStore(), body, req.headers.get("content-type") ?? "");
  // Rien d'exploitable dans le lot -> 400 ; sinon 200 avec le détail (rejets partiels comptés).
  const status = res.accepted + res.duplicates === 0 && res.invalid > 0 ? 400 : 200;
  return NextResponse.json(res, { status });
}

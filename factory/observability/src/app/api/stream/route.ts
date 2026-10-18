import { getStore } from "@/lib/store";
import type { StoredEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;

/**
 * GET /api/stream : SSE. `id:` = séquence du store. Reprise via l'en-tête Last-Event-ID
 * (envoyé automatiquement par EventSource à la reconnexion) ou ?lastEventId=N.
 * Sans reprise, le flux ne délivre que les nouveaux événements.
 */
export async function GET(req: Request) {
  const store = getStore();
  const url = new URL(req.url);
  const hdr = req.headers.get("last-event-id") ?? url.searchParams.get("lastEventId");
  const fromParam = hdr !== null && /^\d+$/.test(hdr) ? Number(hdr) : null;
  let lastSent = fromParam ?? store.lastId();

  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (ev: StoredEvent) => {
        if (ev.id <= lastSent) return;
        lastSent = ev.id;
        controller.enqueue(enc.encode(`id: ${ev.id}\nevent: event\ndata: ${JSON.stringify(ev)}\n\n`));
      };
      // 1) s'abonner d'abord (mise en tampon implicite via lastSent), 2) rejouer, 3) laisser couler le live.
      const onEvent = (ev: StoredEvent) => send(ev);
      store.bus.on("event", onEvent);
      controller.enqueue(enc.encode(`retry: 2000\n: connected\n\n`));
      if (fromParam !== null) {
        for (const ev of store.eventsAfter(fromParam)) send(ev);
      }
      const hb = setInterval(() => {
        try { controller.enqueue(enc.encode(`: hb\n\n`)); } catch { cleanup(); }
      }, HEARTBEAT_MS);
      cleanup = () => {
        clearInterval(hb);
        store.bus.off("event", onEvent);
        try { controller.close(); } catch { /* déjà fermé */ }
      };
      req.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

import type { Store, IngestOutcome } from "./store";

export const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Découpe un corps de requête en éléments à valider.
 * - JSON (objet ou tableau) si Content-Type: application/json
 * - sinon JSONL : une ligne = un événement. Une ligne illisible est rejetée et comptée.
 */
export function ingestBody(store: Store, body: string, contentType: string): IngestOutcome {
  const items: unknown[] = [];
  let unparseable = 0;
  const outcomeErrors: { index: number; reason: string }[] = [];

  if (contentType.includes("application/json") && !contentType.includes("ndjson")) {
    try {
      const parsed = JSON.parse(body);
      items.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      store.countUnparseable(1, "corps JSON illisible");
      return { accepted: 0, duplicates: 0, invalid: 1, errors: [{ index: 0, reason: "corps JSON illisible" }] };
    }
  } else {
    body.split("\n").forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      try {
        items.push(JSON.parse(line));
      } catch {
        unparseable++;
        if (outcomeErrors.length < 20) outcomeErrors.push({ index: i, reason: "ligne JSON illisible" });
      }
    });
    if (unparseable) store.countUnparseable(unparseable, "ligne JSON illisible");
  }

  const res = store.ingest(items);
  return {
    ...res,
    invalid: res.invalid + unparseable,
    errors: [...outcomeErrors, ...res.errors].slice(0, 20),
  };
}

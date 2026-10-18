/**
 * Empreintes de diff (§4.4 : « même hash de diff ou similarité > 90 % »). Aucun contenu n'est conservé : seules les empreintes
 * circulent dans les événements (§5.3). Convention d'événement `git.commit` (émis par L9.3) :
 *   detail = { diff_hash, diff_simhash, lines_changed, "file_hash:<chemin>": <hash du fichier après le commit> ... }
 */
import { createHash } from "node:crypto";

/** Hash hexadécimal court (16 car., 64 bits) d'un texte. */
export function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** Simhash 64 bits sur les mots (hex 16 car.) : deux textes quasi identiques ont des empreintes proches en distance de Hamming. */
export function simhash64(text: string): string {
  const acc = new Array<number>(64).fill(0);
  for (const tok of text.split(/\s+/)) {
    if (!tok) continue;
    const h = BigInt("0x" + hashText(tok));
    for (let b = 0; b < 64; b++) acc[b]! += (h >> BigInt(b)) & 1n ? 1 : -1;
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if (acc[b]! > 0) out |= 1n << BigInt(b);
  return out.toString(16).padStart(16, "0");
}

/** Similarité [0,1] = 1 - distance de Hamming / 64. */
export function simhashSimilarity(a: string, b: string): number {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let bits = 0;
  while (x) { bits += Number(x & 1n); x >>= 1n; }
  return 1 - bits / 64;
}

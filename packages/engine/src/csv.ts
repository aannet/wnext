// Analyseur CSV RFC 4180, pur et sans dépendance (import simple, US-1.2 ; contrat : @wnext/contracts imports.ts).
//  * BOM UTF-8 initial retiré ; fins de ligne CRLF, LF ou CR (une seule rupture chacune).
//  * Séparateur `,` ou `;` : celui qui apparaît le plus souvent HORS guillemets sur le premier enregistrement (les exports Excel
//    français utilisent `;`) ; égalité ou aucun : `,`.
//  * Champ cité : `"…"`, guillemet doublé = guillemet, séparateurs et sauts de ligne littéraux. Tolérances : un guillemet au
//    milieu d'un champ non cité est littéral, le texte collé après un guillemet fermant est conservé.
//  * Ligne entièrement vide (non citée) : ignorée. `line` = ligne physique où commence l'enregistrement (1 = première ligne),
//    sauts de ligne internes aux champs cités compris : c'est le numéro que l'utilisateur voit dans son tableur ou son éditeur.
//  * Guillemet jamais fermé : l'enregistrement qui le contient est abandonné (avec la fin du texte) et `unterminatedAt` porte sa ligne.

export type CsvDelimiter = "," | ";";
export interface CsvRecord { line: number; fields: string[] }
export interface CsvParseResult { delimiter: CsvDelimiter; records: CsvRecord[]; unterminatedAt: number | null }

export function detectDelimiter(text: string): CsvDelimiter {
  let comma = 0;
  let semi = 0;
  let quoted = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === "\n" || c === "\r") break;
    else if (c === ",") comma++;
    else if (c === ";") semi++;
  }
  return semi > comma ? ";" : ",";
}

export function parseCsv(input: string): CsvParseResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let quotedRecord = false; // un champ cité rend l'enregistrement non vide, même s'il ne contient rien
  let line = 1;
  let start = 1;
  let i = 0;
  const n = text.length;

  const endRecord = () => {
    fields.push(field);
    if (fields.length > 1 || fields[0] !== "" || quotedRecord) records.push({ line: start, fields });
    fields = [];
    field = "";
    quotedRecord = false;
  };
  /** Consomme une rupture de ligne en `i` (CRLF compte pour une) ; renvoie false si `i` n'en est pas une. */
  const lineBreak = (): boolean => {
    const c = text[i];
    if (c !== "\n" && c !== "\r") return false;
    i += c === "\r" && text[i + 1] === "\n" ? 2 : 1;
    line++;
    return true;
  };

  while (i < n) {
    if (text[i] === '"' && field === "") {
      // Champ cité.
      quotedRecord = true;
      i++;
      for (;;) {
        if (i >= n) return { delimiter, records, unterminatedAt: start };
        const c = text[i]!;
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          i++;
          break;
        }
        const from = i;
        if (lineBreak()) field += text.slice(from, i); // saut de ligne littéral, compté
        else { field += c; i++; }
      }
      continue;
    }
    const c = text[i]!;
    if (c === delimiter) { fields.push(field); field = ""; i++; continue; }
    if (lineBreak()) { endRecord(); start = line; continue; }
    field += c;
    i++;
  }
  if (field !== "" || fields.length > 0 || quotedRecord) endRecord();
  return { delimiter, records, unterminatedAt: null };
}

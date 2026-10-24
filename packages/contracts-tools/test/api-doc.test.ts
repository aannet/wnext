import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSpec } from "../src/openapi";
import { buildRealtimeComponents, renderApiDoc } from "../src/api-doc";
import { paths } from "../src/paths";

const spec = buildSpec() as any;
const html = renderApiDoc(spec, buildRealtimeComponents());
const operations = Object.entries(spec.paths as Record<string, Record<string, any>>).flatMap(([path, item]) =>
  Object.entries(item).map(([method, op]) => ({ path, method, op })),
);

describe("doc API HTML generee depuis la spec", () => {
  it("decrit chaque operation (ancre = operationId, methode, chemin, resume)", () => {
    expect(operations.length).toBeGreaterThan(50);
    for (const { path, method, op } of operations) {
      expect(html).toContain(`id="op-${op.operationId}"`);
      expect(html).toContain(`<span class="verb ${method}">${method.toUpperCase()}</span>`);
      expect(html).toContain(`<code class="path">${path}</code>`);
    }
  });

  it("chaque lien interne pointe vers une ancre existante", () => {
    const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(100);
    expect(hrefs.filter((h) => !ids.has(h))).toEqual([]);
  });

  it("documente chaque schema nomme, chaque code d'erreur et le canal temps reel", () => {
    for (const name of Object.keys(spec.components.schemas)) expect(html).toContain(`id="schema-${name}"`);
    for (const code of spec.components.schemas.ErrorCode.enum) expect(html).toContain(`<code>${code}</code>`);
    for (const type of ["subscribe", "changes", "ready", "resync", "error", "notifications"]) expect(html).toContain(`&quot;${type}&quot;`);
    expect(html).toContain("/api/v1/realtime");
  });

  it("echappe le texte venu du contrat", () => {
    const evil = JSON.parse(JSON.stringify(spec));
    evil.paths["/api/v1/health"].get.summary = "<script>alert(1)</script>";
    const out = renderApiDoc(evil, buildRealtimeComponents());
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("suit la convention des docs HTML : theme clair seul, sommaire lateral", () => {
    expect(html).toContain("color-scheme: light");
    expect(html).not.toContain("prefers-color-scheme");
    expect(html).toContain('<aside class="side">');
  });

  it("est deterministe et la doc commitee est a jour", () => {
    expect(renderApiDoc(buildSpec() as any, buildRealtimeComponents())).toBe(html);
    expect(readFileSync(paths.apiDoc, "utf8")).toBe(html);
  });
});

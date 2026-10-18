import { describe, expect, it } from "vitest";
import { hashText, simhash64, simhashSimilarity } from "../../src/core/fingerprint";

const text = (n: number, tweak = -1) => Array.from({ length: n }, (_, i) => `const v${i} = compute(${i === tweak ? "changed" : i}) + helper_${i % 7};`).join("\n");

describe("fingerprint", () => {
  it("hashText déterministe, hex", () => {
    expect(hashText("a")).toBe(hashText("a"));
    expect(hashText("a")).not.toBe(hashText("b"));
    expect(hashText("a")).toMatch(/^[0-9a-f]{16}$/);
  });
  it("simhash : identique = 1, quasi identique > 0,9, différent nettement plus bas", () => {
    const a = simhash64(text(200));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(simhashSimilarity(a, simhash64(text(200)))).toBe(1);
    expect(simhashSimilarity(a, simhash64(text(200, 100)))).toBeGreaterThan(0.9);
    const other = simhash64(Array.from({ length: 200 }, (_, i) => `function totally_${i * 31}(zz) { return zz * ${i}; }`).join("\n"));
    expect(simhashSimilarity(a, other)).toBeLessThan(0.8);
  });
});

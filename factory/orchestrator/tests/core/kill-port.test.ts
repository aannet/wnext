import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileKillSwitch } from "../../src/core/kill-port";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "kill-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("createFileKillSwitch (adaptateur factory/lib/kill.mjs)", () => {
  it("trigger crée le fichier KILL via stopAll, isActive le voit ; ne le lève jamais", async () => {
    const killFile = path.join(dir, "KILL");
    const ks = await createFileKillSwitch({ killFile, stateFile: path.join(dir, "state", "sessions.json") });
    expect(ks.isActive()).toBe(false);
    await ks.trigger("test");
    expect(existsSync(killFile)).toBe(true);
    expect(ks.isActive()).toBe(true);
    expect((ks as { resume?: unknown }).resume).toBeUndefined();
  });
});

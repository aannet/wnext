// dev:stack refuse une seconde pile sur les mêmes ports. Sous WSL en réseau « mirrored », une connexion vers un port local
// fermé ne reçoit ni réponse ni refus : sans délai, la sonde attendait indéfiniment et la pile restait muette.
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { portBusy } from "../../scripts/port-busy.mjs";

describe("portBusy", () => {
  it("voit un port écouté", async () => {
    const srv = createServer().listen(0, "127.0.0.1");
    await new Promise((res) => srv.once("listening", res));
    try {
      expect(await portBusy((srv.address() as AddressInfo).port)).toBe(true);
    } finally {
      srv.close();
    }
  });

  it("répond « libre » pour un port fermé, en un temps borné", async () => {
    const srv = createServer().listen(0, "127.0.0.1");
    await new Promise((res) => srv.once("listening", res));
    const { port } = srv.address() as AddressInfo;
    await new Promise((res) => srv.close(res));
    const t0 = Date.now();
    expect(await portBusy(port, { timeoutMs: 500 })).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

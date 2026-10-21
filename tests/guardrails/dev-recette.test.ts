// RT-035 : la recette avec connexion se lance en une commande, l'écran en OIDC aligné sur la pile (`npm run dev:recette`).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recettePlan } from "../../scripts/dev-recette.mjs";

describe("dev:recette (RT-035)", () => {
  it("lance la pile en --oidc et l'écran en VITE_AUTH_MODE=oidc, ports par défaut", () => {
    const plan = recettePlan({}, []);
    expect(plan.stack.args).toEqual(["scripts/dev-stack.mjs", "--oidc"]);
    expect(plan.web.env).toMatchObject({
      VITE_AUTH_MODE: "oidc",
      VITE_OIDC_ISSUER: "http://127.0.0.1:3010",
      WNEXT_API_URL: "http://127.0.0.1:3000",
    });
    expect(plan.healthUrl).toBe("http://127.0.0.1:3000/api/v1/health");
  });

  it("suit les ports surchargés et transmet --reset à la pile", () => {
    const plan = recettePlan({ WNEXT_DEV_API_PORT: "3400", WNEXT_DEV_IDP_PORT: "3410" }, ["--reset"]);
    expect(plan.stack.args).toEqual(["scripts/dev-stack.mjs", "--oidc", "--reset"]);
    expect(plan.web.env).toMatchObject({ VITE_OIDC_ISSUER: "http://127.0.0.1:3410", WNEXT_API_URL: "http://127.0.0.1:3400" });
    expect(plan.healthUrl).toBe("http://127.0.0.1:3400/api/v1/health");
  });

  it("est exposé par npm run dev:recette", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["dev:recette"]).toBe("node scripts/dev-recette.mjs");
  });
});

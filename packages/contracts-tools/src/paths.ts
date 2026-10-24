import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const paths = {
  root,
  spec: resolve(root, "packages/contracts/openapi.json"),
  client: resolve(root, "apps/web/src/api/client.gen.ts"),
  allowlist: resolve(root, "packages/contracts-tools/breaking-allowlist.json"),
  apiDoc: resolve(root, "docs/03-tech/api.html"),
};

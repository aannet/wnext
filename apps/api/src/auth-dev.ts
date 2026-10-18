import type { IncomingHttpHeaders } from "node:http";
import type { RequestContext } from "./db";

// Authentification DE DÉVELOPPEMENT : l'identité vient d'en-têtes `x-dev-*`, sans aucune preuve. À ne jamais exposer :
// loadConfig refuse ce mode en production. Remplacée par le vrai mécanisme (session, jeton) quand il sera décidé ;
// le reste de l'API ne dépend que de la signature `authenticate(headers) -> RequestContext | null`.

const ROLES = new Set<RequestContext["role"]>(["owner", "admin", "project_manager", "member", "guest"]);
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export async function devAuthenticate(headers: IncomingHttpHeaders): Promise<RequestContext | null> {
  const accountId = one(headers["x-dev-account-id"]);
  const userId = one(headers["x-dev-user-id"]);
  const role = one(headers["x-dev-role"]) as RequestContext["role"] | undefined;
  if (!accountId || !userId || !role) return null;
  if (!/^\d{1,18}$/.test(accountId) || !/^\d{1,18}$/.test(userId) || !ROLES.has(role)) return null;
  return { accountId, userId, role };
}

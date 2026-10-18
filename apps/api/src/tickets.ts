import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { REALTIME_TICKET_TTL_SECONDS, type RealtimeTicket } from "@wnext/contracts";
import type { RequestContext } from "./db";

// Tickets d'upgrade du temps réel (contrat : packages/contracts/src/realtime.ts). Un navigateur ne peut pas poser d'en-tête sur un
// WebSocket : il demande un ticket par POST (authentifié normalement) puis le passe dans `?ticket=`.
// Le ticket est SANS ÉTAT côté serveur : identité (compte, utilisateur, rôle) + échéance + identifiant aléatoire, signés en HMAC-SHA256
// avec un secret partagé par les instances ; n'importe quelle instance peut donc émettre ou accepter un ticket.
// L'usage unique est appliqué par instance (mémoire des identifiants déjà présentés jusqu'à leur échéance) : un ticket rejoué sur une
// AUTRE instance dans ses 30 s de vie serait accepté. Risque accepté (ticket court, lié à un compte, qui ne donne que le flux de
// références du temps réel) ; le fermer exigerait un stockage partagé (base ou cache).
// Le rôle est figé à l'émission : sur 30 s, et le flux n'applique aucune autorisation par rôle (il ne diffuse que des références du compte).

const MAC_BYTES = 32;
const ROLES = new Set<RequestContext["role"]>(["owner", "admin", "project_manager", "member", "guest"]);
const MAX_USED = 100_000; // garde-fou mémoire : au-delà, on purge d'abord les échus

export interface TicketService {
  issue(ctx: RequestContext): RealtimeTicket;
  /** Contexte lié au ticket s'il est authentique, non expiré et jamais présenté ; null sinon. Consomme le ticket. */
  redeem(ticket: string): RequestContext | null;
}

export interface TicketOptions {
  secret: Buffer | string;
  ttlSeconds?: number;
  now?: () => number;
}

export function createTicketService(opts: TicketOptions): TicketService {
  const secret = typeof opts.secret === "string" ? Buffer.from(opts.secret) : opts.secret;
  if (secret.length < 32) throw new Error("secret de ticket trop court (32 octets au moins)");
  const ttl = opts.ttlSeconds ?? REALTIME_TICKET_TTL_SECONDS;
  const now = opts.now ?? (() => Date.now());
  const used = new Map<string, number>(); // identifiant -> échéance (s)

  const mac = (payload: Buffer) => createHmac("sha256", secret).update(payload).digest();
  const sweep = (t: number) => { for (const [j, e] of used) if (e <= t) used.delete(j); };

  return {
    issue(ctx) {
      const exp = Math.floor(now() / 1000) + ttl;
      const payload = Buffer.from(JSON.stringify({ a: ctx.accountId, u: ctx.userId, r: ctx.role, e: exp, j: randomBytes(16).toString("base64url") }));
      return { ticket: Buffer.concat([mac(payload), payload]).toString("base64url"), expiresInSeconds: ttl };
    },
    redeem(ticket) {
      if (ticket.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(ticket)) return null;
      const raw = Buffer.from(ticket, "base64url");
      if (raw.length <= MAC_BYTES) return null;
      const payload = raw.subarray(MAC_BYTES);
      const given = raw.subarray(0, MAC_BYTES);
      if (!timingSafeEqual(given, mac(payload))) return null; // authenticité d'abord : rien du contenu n'est lu avant
      let p: { a?: unknown; u?: unknown; r?: unknown; e?: unknown; j?: unknown };
      try { p = JSON.parse(payload.toString("utf8")); } catch { return null; }
      if (typeof p.a !== "string" || typeof p.u !== "string" || typeof p.j !== "string" || typeof p.e !== "number" || !ROLES.has(p.r as RequestContext["role"])) return null;
      const t = Math.floor(now() / 1000);
      if (t >= p.e) return null;
      if (used.has(p.j)) return null;
      if (used.size >= 1024) sweep(t); // les échus ne servent plus : purge dès que la table grossit
      if (used.size >= MAX_USED) return null; // saturé de tickets valides : refuser plutôt que laisser grossir
      used.set(p.j, p.e);
      return { accountId: p.a, userId: p.u, role: p.r as RequestContext["role"] };
    },
  };
}

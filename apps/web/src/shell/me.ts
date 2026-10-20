// Utilisateur connecté (GET /me) : chargement, utilisateur fictif de la démo, droits d'affichage déduits du rôle.
// Le masquage n'est qu'un confort : l'API reste seule juge (403 FORBIDDEN).
import type { Me } from "@wnext/contracts";
import type { createClient } from "../api/client.gen";

export type MeState =
  | { status: "loading" }
  | { status: "ready"; me: Me }
  | { status: "unauthenticated" }
  | { status: "error" };

export async function loadMe(api: Pick<ReturnType<typeof createClient>, "getMe">): Promise<MeState> {
  try {
    const r = await api.getMe();
    if (r.ok) return { status: "ready", me: r.data };
    return { status: r.status === 401 ? "unauthenticated" : "error" };
  } catch {
    return { status: "error" };
  }
}

/** Mode démo (?demo=1) : pas de connexion, un utilisateur fictif propriétaire du compte. */
export function demoMe(): Me {
  return {
    user: { id: "1", name: "Alec", email: "alec@wnext.test" },
    role: "owner",
    person: null,
    account: { id: "1", name: "WNEXT Démo", timezone: "Europe/Paris", weekStart: 1, defaultLocale: "fr" },
  };
}

type Role = Me["role"];
const ADMINS: ReadonlySet<Role> = new Set(["owner", "admin"]);
const WRITERS: ReadonlySet<Role> = new Set(["owner", "admin", "project_manager"]);

/** Import CSV et réglages du compte : owner et admin. */
export const canAdminister = (me: Me) => ADMINS.has(me.role);
/** Écritures du planning (allocations, congés) : owner, admin et project_manager ; member et guest lisent. */
export const canEditSchedule = (me: Me) => WRITERS.has(me.role);

/** Prénom affiché dans « Bonjour » : premier mot du nom. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** Initiales de l'avatar : première lettre des deux premiers mots, en majuscules. */
export function initials(name: string): string {
  const words = name.trim().split(/[\s.@_-]+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words[1]!].map((w) => [...w][0]!) : [...(words[0] ?? "?")].slice(0, 2);
  return letters.join("").toLocaleUpperCase();
}

import { z } from "zod";
import { Id, orNull } from "./common";

// GET /api/v1/me : « qui suis-je » pour la coque applicative (en-tête « Bonjour {prénom} », masquage des actions réservées).
//  * Tout membre authentifié (401 UNAUTHENTICATED sinon) ; réponse bornée au compte et à l'utilisateur de la requête.
//  * `user.name` est le nom affichable : `users.name`, à défaut la partie locale de l'e-mail (jamais vide).
//  * `role` vient de la base (account_members), jamais d'un jeton ni d'un en-tête de rôle côté client.
//  * `person` : la personne planifiable liée (account_members.person_id), null pour un admin ou un guest non planifié.
//  * Le masquage côté web n'est qu'un confort : l'API reste seule juge (403 FORBIDDEN).

export const MeRole = z.enum(["owner", "admin", "project_manager", "member", "guest"]).meta({ id: "MeRole", description: "Rôle de l'utilisateur dans le compte" });
export type MeRole = z.infer<typeof MeRole>;

export const MeUser = z
  .object({ id: Id, name: z.string().min(1).describe("Nom affichable (nom, à défaut e-mail local)"), email: z.string() })
  .meta({ id: "MeUser" });

export const MePerson = z.object({ id: Id, name: z.string() }).meta({ id: "MePerson" });

export const MeAccount = z
  .object({
    id: Id,
    name: z.string(),
    timezone: z.string().describe("Fuseau IANA du compte"),
    weekStart: z.number().int().min(1).max(7).describe("Premier jour affiché, ISO : 1 = lundi ... 7 = dimanche"),
    defaultLocale: z.string().describe("Langue par défaut du compte (BCP 47 court, ex. fr)"),
  })
  .meta({ id: "MeAccount" });

export const Me = z
  .object({ user: MeUser, role: MeRole, person: orNull(MePerson), account: MeAccount })
  .meta({ id: "Me" });
export type Me = z.infer<typeof Me>;

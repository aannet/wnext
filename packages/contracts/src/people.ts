import { z } from "zod";
import { Id, orNull } from "./common";
import { SchedulePeopleType } from "./schedule";

// Écriture des personnes planifiables (people ; distinctes des utilisateurs de connexion, ADR-002). Choix de conception :
//  * Même mécanique que les allocations et les congés : verrou optimiste (PATCH exige If-Match "<version>"), rôles
//    owner/admin/project_manager, références (département, rôle) vérifiées dans le compte (404 NOT_FOUND, params.entity).
//  * PAS de DELETE : supprimer une personne emporterait ses allocations, ses congés et ses temps saisis (clés étrangères en
//    cascade ou RESTRICT). On la DÉSACTIVE (`active: false`) : elle quitte le Schedule et le calcul de capacité, ses données
//    restent, et la réactivation est possible. Une suppression définitive relèverait d'une autre décision (confirmation avec
//    récapitulatif, comme BR-10 pour une équipe).
//  * Aucun coût, taux ni e-mail ici : le contrat de lecture ne les expose pas, l'écriture ne les accepte pas (ADR-001, zéro fuite).
//    Ils viendront avec leurs propres routes et leurs propres droits.
//  * `workDaysHours` : 7 valeurs, index 0 = lundi (ISO, CLAUDE.md), 0 à 24 h. Défaut serveur {8,8,8,8,8,0,0}.
//  * Défauts serveur : peopleType "employee", tags [], active true, pays/département/rôle/avatar null.
//  * Désactiver une personne ne touche pas ses allocations existantes (BR-04 : rien n'est supprimé en silence).

const name = z.string().min(1).max(200).regex(/\S/, "nom vide");
const tags = z.array(z.string().min(1).max(50).regex(/\S/)).max(50);

const fields = {
  name,
  peopleType: SchedulePeopleType.optional(),
  departmentId: orNull(Id).optional(),
  roleId: orNull(Id).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).nullable().optional().describe("ISO 3166-1 alpha-2 ; null = aucun férié de pays"),
  workDaysHours: z.array(z.number().min(0).max(24)).length(7).optional().describe("Heures ouvrées par jour, index 0 = lundi ... 6 = dimanche"),
  tags: tags.optional(),
  avatarUrl: z.string().max(2000).nullable().optional(),
  active: z.boolean().optional(),
};

export const PersonCreate = z.object(fields).meta({ id: "PersonCreate" });
export type PersonCreate = z.infer<typeof PersonCreate>;

// Champs absents = inchangés ; null efface département, rôle, pays ou avatar.
export const PersonPatch = z
  .object(fields)
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "corps vide" })
  .meta({ id: "PersonPatch" });
export type PersonPatch = z.infer<typeof PersonPatch>;

export const PersonPathParams = z.object({ id: Id });

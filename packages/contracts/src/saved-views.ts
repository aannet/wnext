import { z } from "zod";
import { Id, Version } from "./common";
import { ReferenceListQuery } from "./reference";
import { SchedulePage } from "./schedule";

// Vues sauvegardées (FR-10, P4) : un état de filtrage nommé du Schedule, privé ou partagé avec le compte. Choix de conception :
//  * `filters` est typé par `kind`. Seul `schedule` existe côté API (la table connaît d'autres genres, ils s'ajouteront avec leurs filtres).
//    Le schéma est STRICT (clé inconnue = 400 VALIDATION_FAILED) mais ne porte que des champs optionnels : en ajouter plus tard est
//    compatible. Un filtre absent ou liste vide = pas de filtre. Les listes sont des identifiants opaques (ET entre filtres, OU dans une liste).
//  * Visibilité : un utilisateur voit SES vues et les vues PARTAGÉES du compte ; la vue privée d'un autre est NOT_FOUND (pas d'oracle).
//  * Droits d'écriture. Tout membre authentifié peut créer et gérer ses vues PRIVÉES. PARTAGER une vue (shared=true) exige owner, admin
//    ou project_manager (403 FORBIDDEN sinon). Le propriétaire modifie et supprime ses vues. owner et admin du compte gèrent aussi les
//    vues PARTAGÉES des autres (renommer, filtres, position, supprimer), mais ne peuvent pas changer leur `shared` (FORBIDDEN) :
//    seul le propriétaire (re)privatise sa vue. Tout autre cas : FORBIDDEN. `canManage` dit au client si l'appelant peut modifier.
//  * Unicité : (propriétaire, genre, nom) ; un nom déjà pris donne 409 ALREADY_EXISTS (params.entity = saved_view, params.field = name).
//  * Verrou optimiste : PATCH et DELETE exigent If-Match "<version>" (409 VERSION_CONFLICT, 428 PRECONDITION_REQUIRED).
//  * Lecture : liste paginée par curseur, tri par id, filtre optionnel `kind`.

const ids = z.array(Id).max(200);
export const SavedViewZoom = z.enum(["day", "week", "month"]).meta({ id: "SavedViewZoom" });
export const SavedViewPeopleSort = z.enum(["name", "department", "role"]).meta({ id: "SavedViewPeopleSort" });
/** Densité d'affichage du Schedule (RT-005, Q2 du cadrage n°1) : hauteurs de ligne fixes, compacte (~12 personnes), standard (~8), aérée (~6). */
export const SavedViewDensity = z.enum(["compact", "standard", "airy"]).meta({ id: "SavedViewDensity" });

export const ScheduleViewFilters = z
  .object({
    departmentIds: ids.optional(),
    roleIds: ids.optional(),
    projectIds: ids.optional().describe("Personnes allouées à l'un de ces projets (dans la fenêtre affichée)"),
    personIds: ids.optional(),
    tags: z.array(z.string().min(1).max(50)).max(50).optional().describe("Personnes portant l'un de ces tags"),
    zoom: SavedViewZoom.optional(),
    peopleSort: SavedViewPeopleSort.optional().describe("Tri des lignes de personnes (défaut name)"),
    density: SavedViewDensity.optional().describe("Densité d'affichage ; absente : la vue ne change pas la densité courante"),
  })
  .strict()
  .meta({ id: "ScheduleViewFilters" });

const name = z.string().min(1).max(100).regex(/\S/, "nom vide");
const position = z.number().int().min(0).max(32767);
export const SavedViewKind = z.enum(["schedule"]).meta({ id: "SavedViewKind" });

export const SavedView = z
  .object({
    id: Id,
    version: Version,
    kind: SavedViewKind,
    name,
    filters: ScheduleViewFilters,
    shared: z.boolean(),
    position,
    ownerId: Id.describe("Utilisateur propriétaire"),
    canManage: z.boolean().describe("L'appelant peut modifier et supprimer cette vue"),
  })
  .meta({ id: "SavedView" });

export const SavedViewCreate = z
  .object({
    kind: SavedViewKind.optional().describe("Défaut schedule"),
    name,
    filters: ScheduleViewFilters.optional().describe("Défaut {}"),
    shared: z.boolean().optional().describe("Défaut false"),
    position: position.optional(),
  })
  .meta({ id: "SavedViewCreate" });
export const SavedViewPatch = z
  .object({ name, filters: ScheduleViewFilters, shared: z.boolean(), position })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "corps vide" })
  .meta({ id: "SavedViewPatch" });

export const SavedViewListQuery = ReferenceListQuery.extend({ kind: SavedViewKind.optional() });
export const SavedViewList = z.object({ items: z.array(SavedView), page: SchedulePage }).meta({ id: "SavedViewList" });
export const SavedViewPathParams = z.object({ id: Id });

export type ScheduleViewFilters = z.infer<typeof ScheduleViewFilters>;
export type SavedView = z.infer<typeof SavedView>;
export type SavedViewCreate = z.infer<typeof SavedViewCreate>;
export type SavedViewPatch = z.infer<typeof SavedViewPatch>;

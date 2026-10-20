import { z } from "zod";
import { Id, IsoDate, orNull } from "./common";
import { ReferenceListQuery } from "./reference";

// Notifications in-app (FR-10, US-7.3 ; BR-36 / US-3.5 pour le conflit d'édition). Socle MVP : trois types, lu / non lu,
// désabonnement par type ; ni e-mail ni digest (T2). Règles :
//  * Destinataire seul : chaque utilisateur ne lit, ne marque et ne paramètre que les SIENNES, quel que soit son rôle (owner compris).
//    Une notification d'un autre (ou d'un autre compte) est NOT_FOUND, jamais FORBIDDEN (pas d'oracle). La base l'impose aussi (RLS).
//  * Types :
//      allocation_changed : une allocation de MA personne (l'utilisateur lié à la personne planifiée) a été créée, modifiée ou supprimée ;
//      timeoff_decided    : un de MES congés a été approuvé ou refusé ;
//      edit_conflict      : MA modification a été refusée (409 VERSION_CONFLICT) parce qu'une version plus récente existe ; `actor`
//                           est l'auteur de cette version gagnante, `entity`/`entityId` l'entité, `currentVersion` sa version.
//    Jamais pour ses propres écritures (l'auteur n'est pas notifié de ce qu'il a fait lui-même).
//  * Regroupement : UNE notification par destinataire, type et transaction ; `counts` dit combien (« 300 allocations créées »
//    après un import). `entityId` est la première entité touchée, `startDate` le plus petit jour concerné.
//  * Contenu minimal : compteurs, dates, auteur ; aucun taux, coût, nom de projet ni note. Le client compose le texte depuis `type`
//    et `counts` (aucun texte côté API).
//  * Liste : la plus récente d'abord (tri par id décroissant), paginée par curseur ; `unread=true` ne garde que les non lues ;
//    `unreadCount` est toujours le total des non lues de l'appelant (badge), indépendant du filtre et de la page.
//  * Rétention : une notification lue disparaît 30 jours après sa lecture ; toute notification, lue ou non, 90 jours après sa
//    création (migration 0005, purge_notifications).
//  * edit_conflict : pas de doublon tant qu'une notification non lue désigne déjà la même entité à la même version gagnante (un
//    même 409 rejoué ne notifie qu'une fois) ; rien si la version gagnante est de l'appelant lui-même (autre onglet).
//  * Temps réel : le message `notifications` (realtime.ts) n'est envoyé qu'aux connexions du destinataire, et ne porte que le
//    nouveau compteur ; le client recharge la liste s'il l'affiche.

export const NotificationType = z.enum(["allocation_changed", "timeoff_decided", "edit_conflict"]).meta({ id: "NotificationType" });
export type NotificationType = z.infer<typeof NotificationType>;

/** Entités qu'une notification peut désigner (tables des ressources à verrou optimiste). */
export const NotificationEntity = z
  .enum([
    "allocations", "timeoffs", "people", "logged_time", "departments", "roles", "timeoff_types", "holidays", "projects", "clients",
    "phases", "project_tasks", "milestones", "project_expenses", "project_budget_lines", "saved_views",
  ])
  .meta({ id: "NotificationEntity" });
export type NotificationEntity = z.infer<typeof NotificationEntity>;

const count = z.number().int().min(0);
export const NotificationCounts = z
  .object({ created: count, updated: count, deleted: count, approved: count, declined: count })
  .meta({ id: "NotificationCounts", description: "Compteurs regroupés ; 0 pour ceux qui ne s'appliquent pas au type" });

export const NotificationActor = z
  .object({ id: Id, name: orNull(z.string()).describe("Nom affiché ; null si l'utilisateur n'en a pas") })
  .meta({ id: "NotificationActor" });

export const Notification = z
  .object({
    id: Id,
    type: NotificationType,
    entity: NotificationEntity,
    entityId: Id,
    actor: orNull(NotificationActor).describe("Auteur du changement (ou de la version gagnante) ; null = système ou utilisateur supprimé"),
    counts: NotificationCounts,
    startDate: orNull(IsoDate).describe("Plus petit jour concerné (allocations, congés) ; null pour edit_conflict"),
    currentVersion: orNull(z.number().int().min(1)).describe("edit_conflict : version gagnante ; null sinon"),
    createdAt: z.string().describe("Horodatage ISO 8601 (UTC)"),
    readAt: orNull(z.string()).describe("Horodatage ISO 8601 du marquage lu ; null = non lue"),
  })
  .meta({ id: "Notification" });
export type Notification = z.infer<typeof Notification>;

export const NotificationListQuery = ReferenceListQuery.extend({
  unread: z.boolean().optional().describe("true : seulement les non lues"),
});
export const NotificationPage = z
  .object({ nextCursor: orNull(z.string()).describe("null = dernière page"), total: count.describe("Nombre de notifications correspondant au filtre") })
  .meta({ id: "NotificationPage" });
export const NotificationList = z
  .object({ items: z.array(Notification), page: NotificationPage, unreadCount: count.describe("Total des non lues de l'appelant") })
  .meta({ id: "NotificationList" });
export const NotificationPathParams = z.object({ id: Id });
export const NotificationReadAllResult = z
  .object({ marked: count.describe("Notifications passées à lues par cet appel"), unreadCount: count })
  .meta({ id: "NotificationReadAllResult" });

/** Préférence d'un type : `enabled = false` = désabonné (aucune notification de ce type n'est créée tant qu'il le reste). */
export const NotificationPreference = z.object({ type: NotificationType, enabled: z.boolean() }).meta({ id: "NotificationPreference" });
/** Toujours les trois types, dans l'ordre de NotificationType ; un type jamais réglé est abonné (défaut). */
export const NotificationPreferences = z.object({ items: z.array(NotificationPreference) }).meta({ id: "NotificationPreferences" });
/** PUT : les types listés sont réglés, les autres restent inchangés ; un type au plus une fois. */
export const NotificationPreferencesUpdate = z
  .object({ items: z.array(NotificationPreference).min(1).max(3) })
  .refine((b) => new Set(b.items.map((i) => i.type)).size === b.items.length, { message: "type répété", path: ["items"] })
  .meta({ id: "NotificationPreferencesUpdate" });
export type NotificationPreferencesUpdate = z.infer<typeof NotificationPreferencesUpdate>;

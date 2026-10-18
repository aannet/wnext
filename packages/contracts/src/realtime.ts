import { z } from "zod";
import { ErrorCode } from "./errors";
import { Id, Version } from "./common";

// Contrat temps réel (ADR-003 §5). Le canal ne fait que DIFFUSER : aucune écriture par WebSocket, les mutations passent par REST.
//  * Source : l'outbox change_log (schema.sql). Un message ne porte que des références (entité, id, version), jamais les
//    données : le client recharge l'entité (ou ignore le message si sa copie a déjà cette version ou plus récente).
//  * `seq` est un curseur par compte, monotone et sans trou ; il est une chaîne opaque côté client (comme `changeCursor`
//    de GET /schedule, qui en est le point de départ).
//  * Rejouer un message déjà vu est inoffensif (idempotence par `version`).
//  * Le contexte du compte vient de la session à la connexion, jamais d'un champ du message.
//  * `v` est la version du protocole ; un changement cassant l'incrémente (jamais de réinterprétation silencieuse).
//  * Refus à l'upgrade (avant toute trame, donc en HTTP, sans corps) :
//      401 : non authentifié. Le client se ré-authentifie ; il ne réessaie pas tel quel.
//      404 : mauvais chemin (REALTIME_PATH).
//      429 : le compte a atteint son plafond de connexions simultanées, OU trop de tentatives de connexion en peu de temps (limite de
//            débit par compte, fenêtre glissante). Dans les deux cas l'en-tête `Retry-After` (secondes) donne l'attente
//            minimale (REALTIME_RETRY_AFTER_SECONDS) ; le client réessaie après au moins ce délai, avec un aléa et une
//            attente croissante, sans boucle serrée. Il continue d'afficher ses données (GET /schedule) en attendant :
//            le temps réel est un confort de fraîcheur, pas une condition de lecture.
//      500 : erreur interne d'authentification ; même conduite qu'un 429, avec attente croissante.
//    Le plafond et la limite de débit sont par compte et par processus serveur ; leurs valeurs sont de configuration, hors contrat.
//  * Authentification de l'upgrade : soit les en-têtes habituels (`Authorization`), soit un TICKET dans la requête
//    (`?ticket=...`) pour les navigateurs, qui ne peuvent pas poser d'en-tête sur un WebSocket.
//      - Le ticket s'obtient par POST REALTIME_TICKET_PATH (authentifié normalement, tout rôle). Il est lié à l'utilisateur et au
//        compte qui l'ont demandé, valable REALTIME_TICKET_TTL_SECONDS secondes, et destiné à UNE connexion : le client en demande
//        un nouveau à chaque tentative, reconnexions comprises (ne jamais réutiliser ni stocker un ticket).
//      - L'émission est limitée en débit (fenêtre glissante, par utilisateur et par compte) : au-delà, 429 RATE_LIMITED avec l'en-tête
//        `Retry-After` (secondes) et params.retryAfterSeconds (même valeur). Le client attend au moins ce délai avant de redemander
//        un ticket, avec son attente croissante habituelle ; il continue d'afficher ses données en attendant. Un ticket présenté à
//        l'upgrade compte comme une tentative de connexion (voir 429 ci-dessus).
//      - Un ticket invalide, expiré, déjà utilisé ou altéré est refusé en 401 comme une absence d'identité : le client redemande un
//        ticket (si c'est POST qui répond 401, il se ré-authentifie).
//      - Le ticket est une valeur opaque ; il ne contient rien que le client doive lire. Il peut apparaître dans les journaux
//        d'accès d'un intermédiaire : sa courte durée et son usage unique en limitent la portée.

export const REALTIME_PATH = "/api/v1/realtime";
export const REALTIME_PROTOCOL_VERSION = 1;

/** Statuts HTTP de refus à l'upgrade qui portent une conduite précise pour le client (voir l'en-tête de ce fichier). */
export const REALTIME_UPGRADE_STATUS = { unauthenticated: 401, tooManyConnections: 429 } as const;
/** Valeur de l'en-tête `Retry-After` d'un 429 : attente minimale en secondes avant de se reconnecter. */
export const REALTIME_RETRY_AFTER_SECONDS = 5;

/** Chemin du POST qui délivre un ticket d'upgrade, et nom du paramètre de requête qui le porte (`/api/v1/realtime?ticket=...`). */
export const REALTIME_TICKET_PATH = "/api/v1/realtime/ticket";
export const REALTIME_TICKET_PARAM = "ticket";
/** Durée de validité d'un ticket, en secondes. */
export const REALTIME_TICKET_TTL_SECONDS = 30;

/** Ticket d'upgrade : valeur opaque (base64url) à passer dans `?ticket=` dans les `expiresInSeconds` qui suivent. */
export const RealtimeTicket = z
  .object({
    ticket: z.string().regex(/^[A-Za-z0-9_-]{16,1024}$/),
    expiresInSeconds: z.number().int().positive(),
  })
  .meta({ id: "RealtimeTicket" });
export type RealtimeTicket = z.infer<typeof RealtimeTicket>;

/**
 * Entités journalisées (trigger log_change de schema.sql) : celles du Schedule, puis la structure des projets
 * (clients, phases, tâches, jalons, équipe). Les dépenses et lignes de budget (données financières) n'y sont JAMAIS :
 * un message, même sans donnée, révélerait leur existence à des rôles qui n'ont pas le droit de les lire.
 *  * `project_team` n'a pas d'identifiant propre : `id` est celui du PROJET et le message signifie « l'équipe de ce projet a
 *    changé, recharge-la » (toujours `op = update` tant que le projet existe ; sa suppression est portée par `projects`).
 *    Sa `version` est le `seq` du message (monotone par compte), non la version du projet.
 */
export const ChangeEntity = z
  .enum([
    "allocations", "timeoffs", "people", "holidays", "projects", "timeoff_types", "departments", "roles",
    "clients", "phases", "project_tasks", "milestones", "project_team",
  ])
  .meta({ id: "ChangeEntity" });
export type ChangeEntity = z.infer<typeof ChangeEntity>;

export const Change = z
  .object({
    seq: z.string().regex(/^\d{1,15}$/),
    entity: ChangeEntity,
    id: Id,
    op: z.enum(["insert", "update", "delete"]),
    /** version après l'opération ; null pour un delete (miroir de change_log : delete <=> version NULL) */
    version: z.union([Version, z.null()]),
  })
  .refine((c) => (c.op === "delete") === (c.version === null), { message: "version null si et seulement si op = delete" })
  .meta({ id: "Change" });
export type Change = z.infer<typeof Change>;

const cursor = z.string().regex(/^\d{1,15}$/);

// ----- client -> serveur : un seul message, la reprise -----

/** Premier message après la connexion : reprendre après `cursor` (le `changeCursor` de GET /schedule ou le dernier `head` reçu). */
export const RealtimeSubscribe = z
  .object({ v: z.literal(REALTIME_PROTOCOL_VERSION), type: z.literal("subscribe"), cursor })
  .meta({ id: "RealtimeSubscribe" });
export const RealtimeClientMessage = RealtimeSubscribe;
export type RealtimeClientMessage = z.infer<typeof RealtimeClientMessage>;

// ----- serveur -> client -----

/** Lot de changements, dans l'ordre de `seq`. `head` = dernier `seq` connu du serveur à l'émission ; le client le mémorise comme nouveau curseur. */
export const RealtimeChanges = z
  .object({
    v: z.literal(REALTIME_PROTOCOL_VERSION),
    type: z.literal("changes"),
    changes: z.array(Change).min(1).max(1000),
    /** curseur à mémoriser après traitement du lot (= seq du dernier changement du lot) */
    cursor,
    /** vrai si d'autres lots suivent immédiatement (rattrapage en cours) */
    hasMore: z.boolean(),
  })
  .meta({ id: "RealtimeChanges" });

/** Le curseur est plus ancien que la rétention du journal (BR-14) : le client recharge la fenêtre (GET /schedule) puis se réabonne avec le nouveau `changeCursor`. */
export const RealtimeResync = z
  .object({ v: z.literal(REALTIME_PROTOCOL_VERSION), type: z.literal("resync"), reason: z.literal("cursor_expired"), head: cursor })
  .meta({ id: "RealtimeResync" });

/** Abonné et à jour : le flux direct commence. Évite au client de deviner la fin du rattrapage. */
export const RealtimeReady = z
  .object({ v: z.literal(REALTIME_PROTOCOL_VERSION), type: z.literal("ready"), cursor })
  .meta({ id: "RealtimeReady" });

/** Erreur de protocole (message illisible, curseur invalide, non authentifié). Codes stables, jamais de texte. */
export const RealtimeError = z
  .object({
    v: z.literal(REALTIME_PROTOCOL_VERSION),
    type: z.literal("error"),
    code: ErrorCode,
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  })
  .meta({ id: "RealtimeError" });

export const RealtimeServerMessage = z
  .discriminatedUnion("type", [RealtimeChanges, RealtimeResync, RealtimeReady, RealtimeError])
  .meta({ id: "RealtimeServerMessage" });
export type RealtimeServerMessage = z.infer<typeof RealtimeServerMessage>;

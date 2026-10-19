import pg, { type Pool } from "pg";
import type { Db } from "./db";

// Adaptateur `Db` sur un pool `pg`. Une transaction = une connexion dédiée, BEGIN/COMMIT, ROLLBACK sur erreur.
// La RLS de schema.sql ne s'applique qu'à un rôle non propriétaire : se connecter directement en `app_user`, ou fournir
// `role` pour basculer par SET LOCAL ROLE à chaque transaction (le rôle de connexion doit alors en être membre).

export interface PgDbOptions {
  role?: string;
}

export function pgDb(pool: Pick<Pool, "connect">, options: PgDbOptions = {}): Db {
  if (options.role !== undefined && !/^[a-z_][a-z0-9_]*$/.test(options.role)) throw new Error(`nom de rôle invalide : ${options.role}`);
  return {
    async transaction(fn) {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query("BEGIN");
        if (options.role) await client.query(`SET LOCAL ROLE ${options.role}`);
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          broken = true; // état de la connexion inconnu : ne pas la remettre dans le pool
        }
        throw err;
      } finally {
        client.release(broken ? true : undefined);
      }
    },
  };
}

const DATE_OID = 1082;

/**
 * Lecteurs de types de l'API (option `types` de `pg.Pool` / `pg.Client`). Une DATE est un jour calendaire sans fuseau : on la
 * garde en texte `YYYY-MM-DD`. Par défaut `pg` la convertit en Date à minuit LOCAL, et la relire en UTC (`toISOString`)
 * recule d'un jour à l'est de UTC. Les `timestamptz` restent des Date (des instants).
 * Choisi plutôt que des `::text` dans chaque SELECT/RETURNING : un seul point, aucune requête future ne peut l'oublier, et
 * pas de `pg.types.setTypeParser` global qui contaminerait tout le processus.
 */
export const pgTypes = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    oid === DATE_OID ? (v: string) => v : pg.types.getTypeParser(oid, format as "text")) as typeof pg.types.getTypeParser,
};

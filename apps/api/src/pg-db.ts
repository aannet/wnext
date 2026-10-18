import type { Pool } from "pg";
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

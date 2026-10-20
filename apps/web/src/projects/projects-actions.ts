// Enchaînements d'écriture de l'écran Projets : le client créé « à la volée » avant le projet qui s'y rattache.
import type { Client } from "@wnext/contracts";
import type { ProjectsError, ProjectsSource } from "../data/projects-source";
import type { FormValues } from "./projects-model";

export type ClientStep = { ok: true; clientId: string | null; created: Client | null } | { ok: false; error: ProjectsError };

/**
 * Résout le client d'un formulaire : celui qui est choisi, ou un nouveau client créé maintenant (nom saisi). `created` dit
 * qu'un client vient d'être écrit : si le projet est ensuite refusé, l'appelant garde ce client pour ne pas le recréer au nouvel essai.
 */
export async function resolveClient(source: Pick<ProjectsSource, "createClient">, v: FormValues): Promise<ClientStep> {
  const name = v.newClientName.trim();
  if (!name) return { ok: true, clientId: v.clientId || null, created: null };
  const r = await source.createClient(name);
  return r.ok ? { ok: true, clientId: r.value.id, created: r.value } : { ok: false, error: r.error };
}

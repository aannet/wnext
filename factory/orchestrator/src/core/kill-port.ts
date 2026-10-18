/**
 * Port du kill-switch global (§4.5). Adaptateur réel : factory/lib/kill.mjs (`stopAll` crée factory/KILL et arrête les groupes
 * de processus suivis). Il n'y a volontairement AUCUNE méthode pour lever le kill-switch : seul un humain (`factory resume`).
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface KillSwitch {
  /** `factory/KILL` présent. Synchrone : consulté avant chaque lancement et à chaque tick. */
  isActive(): boolean;
  /** Crée le kill-switch et arrête les sessions suivies (SIGTERM puis SIGKILL). */
  trigger(reason: string): Promise<void>;
}

interface KillModule {
  isKilled(killFile?: string): boolean;
  stopAll(opts?: Record<string, unknown>): Promise<unknown>;
  killFilePath(): string;
}

export interface FileKillSwitchOptions {
  killFile?: string;
  stateFile?: string;
  /** Défauts de `stopAll` : 10 s de grâce SIGTERM (< stop_deadline_s = 30). */
  graceMs?: number;
  killWaitMs?: number;
  /** Surcharge du module (tests, autre emplacement). */
  modulePath?: string;
}

export async function createFileKillSwitch(opts: FileKillSwitchOptions = {}): Promise<KillSwitch> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const modulePath = opts.modulePath ?? path.resolve(here, "../../../lib/kill.mjs");
  const mod = (await import(/* @vite-ignore */ pathToFileURL(modulePath).href)) as KillModule;
  const killFile = opts.killFile ?? mod.killFilePath();
  return {
    isActive: () => mod.isKilled(killFile),
    trigger: async () => {
      await mod.stopAll({ killFile, ...(opts.stateFile ? { stateFile: opts.stateFile } : {}), ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}), ...(opts.killWaitMs !== undefined ? { killWaitMs: opts.killWaitMs } : {}) });
    },
  };
}

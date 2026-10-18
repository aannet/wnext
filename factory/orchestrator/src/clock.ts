/**
 * Horloge injectable (strategy.md §4.2 : « horloge injectée, pas de Date.now() »).
 * Tout code de l'orchestrateur, du Superviseur et des runners lit le temps ici, jamais via Date.now().
 */
import type { Clock } from "./types";

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      function done() {
        clearTimeout(t);
        signal?.removeEventListener("abort", done);
        resolve();
      }
    }),
};

interface Timer { at: number; resolve: () => void }

/** Horloge manuelle pour les tests : le temps n'avance que par `advance()`. `sleep` rend la main (résolu) si `signal` est annulé. */
export class ManualClock implements Clock {
  private t: number;
  private timers: Timer[] = [];
  constructor(startMs = Date.parse("2026-10-18T09:00:00.000Z")) { this.t = startMs; }

  now(): number { return this.t; }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const timer: Timer = { at: this.t + Math.max(0, ms), resolve };
      this.timers.push(timer);
      signal?.addEventListener("abort", () => {
        this.timers = this.timers.filter((x) => x !== timer);
        resolve();
      }, { once: true });
    });
  }

  /** Avance le temps de `ms`, réveille les timers échus dans l'ordre et laisse les continuations s'exécuter entre chacun. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      await flush();
      const next = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = Math.max(this.t, next.at);
      next.resolve();
    }
    this.t = target;
    await flush();
  }

  pendingTimers(): number { return this.timers.length; }
}

const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/**
 * Verrou de chemin (§4.2) : deux lignes touchant le même fichier sont sérialisées.
 * Acquisition atomique (tout ou rien, donc sans interblocage), FIFO équitable sans dépassement sur un chemin contesté.
 * Un chemin se terminant par `/` verrouille tout son contenu. Aucune horloge nécessaire : réveil sur `release`.
 */
import path from "node:path";

interface Waiter { owner: string; paths: string[]; resolve: () => void; reject: (e: Error) => void; }

const norm = (p: string): string => {
  const n = path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");
  return p.endsWith("/") && !n.endsWith("/") ? n + "/" : n;
};
const overlap = (a: string, b: string): boolean =>
  a === b || (a.endsWith("/") && b.startsWith(a)) || (b.endsWith("/") && a.startsWith(b));

export class PathLockManager {
  private held = new Map<string, string>(); // chemin -> propriétaire
  private queue: Waiter[] = [];

  holders(): Record<string, string> { return Object.fromEntries(this.held); }

  private free(paths: string[], owner: string): boolean {
    for (const [h, o] of this.held) if (o !== owner && paths.some((p) => overlap(p, h))) return false;
    return true;
  }
  private take(owner: string, paths: string[]): void { for (const p of paths) this.held.set(p, owner); }
  private holds(owner: string): boolean { return [...this.held.values()].includes(owner); }

  tryAcquire(owner: string, paths: string[]): boolean {
    const ps = paths.map(norm);
    if (this.holds(owner)) throw new Error(`verrous déjà détenus par ${owner}`);
    if (this.queue.length && this.queue.some((w) => w.paths.some((a) => ps.some((b) => overlap(a, b))))) return false;
    if (!this.free(ps, owner)) return false;
    this.take(owner, ps);
    return true;
  }

  acquire(owner: string, paths: string[], signal?: AbortSignal): Promise<void> {
    if (this.holds(owner)) return Promise.reject(new Error(`verrous déjà détenus par ${owner}`));
    if (this.tryAcquire(owner, paths)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = { owner, paths: paths.map(norm), resolve, reject };
      this.queue.push(w);
      signal?.addEventListener("abort", () => {
        const i = this.queue.indexOf(w);
        if (i >= 0) { this.queue.splice(i, 1); reject(new Error("acquisition annulée")); this.pump(); }
      }, { once: true });
      if (signal?.aborted) { this.queue.splice(this.queue.indexOf(w), 1); reject(new Error("acquisition annulée")); }
    });
  }

  /** Idempotent. */
  release(owner: string): void {
    for (const [p, o] of [...this.held]) if (o === owner) this.held.delete(p);
    this.pump();
  }

  private pump(): void {
    const ahead: Waiter[] = [];
    for (const w of [...this.queue]) {
      const blockedByEarlier = ahead.some((a) => a.paths.some((x) => w.paths.some((y) => overlap(x, y))));
      if (!blockedByEarlier && this.free(w.paths, w.owner)) {
        this.queue.splice(this.queue.indexOf(w), 1);
        this.take(w.owner, w.paths);
        w.resolve();
      } else ahead.push(w);
    }
  }
}

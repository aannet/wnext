// Limite de débit à fenêtre glissante, en mémoire, par clé (compte, utilisateur). Elle protège l'émission des tickets d'upgrade
// et les tentatives de connexion WebSocket (contrat : packages/contracts/src/realtime.ts).
// PAR PROCESSUS : avec N instances, la limite effective d'une clé est au plus N fois la valeur configurée. C'est un garde-fou contre
// l'emballement d'un client (boucle de reconnexion), pas un quota commercial ; un quota exact exigerait un stockage partagé.

export interface RateLimiter {
  /** Compte une tentative pour `key`. 0 = autorisée ; sinon le nombre de secondes (entier >= 1) à attendre avant qu'une place se libère. */
  hit(key: string): number;
}

export interface RateLimiterOptions {
  /** Tentatives autorisées par fenêtre ; 0 ou moins = limite désactivée. */
  limit: number;
  windowMs: number;
  now?: () => number;
  /** Nombre maximal de clés suivies en même temps (défaut 100 000) ; au-delà, la plus anciennement vue est oubliée. */
  maxKeys?: number;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = opts;
  const now = opts.now ?? (() => Date.now());
  const maxKeys = opts.maxKeys ?? 100_000;
  const hits = new Map<string, number[]>(); // clé -> instants des tentatives retenues, croissants
  return {
    hit(key) {
      if (limit <= 0) return 0;
      const t = now();
      const since = t - windowMs;
      let log = hits.get(key);
      if (log) {
        let i = 0;
        while (i < log.length && log[i]! <= since) i++;
        if (i > 0) log.splice(0, i);
      } else {
        if (hits.size >= maxKeys) hits.delete(hits.keys().next().value as string); // garde-fou mémoire
        log = [];
      }
      hits.delete(key); // réinsère en queue : l'ordre d'insertion = ordre de dernière vue
      hits.set(key, log);
      if (log.length >= limit) return Math.max(1, Math.ceil((log[0]! + windowMs - t) / 1000)); // une tentative refusée n'est pas comptée
      log.push(t);
      return 0;
    },
  };
}

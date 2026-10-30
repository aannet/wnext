// Sonde de port local (dev:stack). Sous WSL en réseau « mirrored », une connexion vers un port fermé n'est ni acceptée ni
// refusée : elle reste en attente. Passé le délai, personne n'écoute : le port est considéré libre.
import { connect } from "node:net";

export function portBusy(port, { host = "127.0.0.1", timeoutMs = 1500 } = {}) {
  return new Promise((res) => {
    const s = connect({ host, port });
    const done = (busy) => { clearTimeout(t); s.destroy(); res(busy); };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

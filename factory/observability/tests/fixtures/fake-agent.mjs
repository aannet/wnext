// Faux « agent » : boucle et lance 2 enfants (qui bouclent aussi). argv : <pidfile> [stubborn]
// stubborn : ignore SIGTERM (agent récalcitrant) pour exercer l'escalade SIGKILL.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
const [pidfile, mode, role] = process.argv.slice(2);
if (mode === "stubborn") process.on("SIGTERM", () => {});
if (role !== "child") {
  for (let i = 0; i < 2; i++) spawn(process.execPath, [process.argv[1], pidfile, mode ?? "", "child"], { stdio: "ignore" });
}
appendFileSync(pidfile, `${process.pid}\n`);
setInterval(() => {}, 1000);

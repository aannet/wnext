// Point d'entrée de l'écran. Langue : ?lang=en|pseudo, français par défaut.
//  * Par défaut : branché sur l'API (proxy Vite /api, identité de développement via src/data/auth-fetch.ts) avec temps réel.
//  * ?demo=1 : démo locale sans API (src/demo.ts) ; les gestes s'y appliquent localement (src/data/demo-source.ts).
import { todayIn } from "@wnext/engine";
import { createRoot } from "react-dom/client";
import { createClient } from "./api/client.gen";
import { createAuthFetch } from "./data/auth-fetch";
import { createDemoSource } from "./data/demo-source";
import { createScheduleSource } from "./data/schedule-source";
import { createI18n, type UiLocale } from "./i18n";
import { ScheduleContainer } from "./ScheduleContainer";
import { demoSchedule } from "./demo";

const params = new URLSearchParams(location.search);
const lang = params.get("lang");
const locale: UiLocale = lang === "en" || lang === "pseudo" ? lang : "fr";
const i18n = createI18n(locale);
document.documentElement.lang = locale === "en" ? "en" : "fr";
const widthPx = window.innerWidth - 32;
const heightPx = window.innerHeight - 120;
const root = createRoot(document.getElementById("root")!);

if (params.get("demo") === "1") {
  const source = createDemoSource(demoSchedule(todayIn("Europe/Paris", new Date())));
  root.render(<ScheduleContainer i18n={i18n} source={source} widthPx={widthPx} heightPx={heightPx - 24} />);
} else {
  const api = createClient({ baseUrl: "", fetch: createAuthFetch(import.meta.env) });
  const wsBase = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  const source = createScheduleSource({ api, realtime: { wsBase, onError: (err) => console.warn(err) } });
  root.render(<ScheduleContainer i18n={i18n} source={source} widthPx={widthPx} heightPx={heightPx - 24} />);
}

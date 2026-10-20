// Point d'entrée de l'écran. Langue : ?lang=en|pseudo, français par défaut.
//  * Par défaut : branché sur l'API (proxy Vite /api) avec temps réel. Identité selon VITE_AUTH_MODE (src/data/auth-fetch.ts) :
//    `dev` (défaut) en-têtes x-dev-* ; `oidc` connexion OIDC PKCE (src/data/oidc.ts) avant le premier rendu de l'écran.
//  * ?demo=1 : démo locale sans API (src/demo.ts) ; les gestes s'y appliquent localement (src/data/demo-source.ts).
import { todayIn } from "@wnext/engine";
import { createRoot } from "react-dom/client";
import { createClient } from "./api/client.gen";
import { createAuthFetch, devAuthProvider, oidcAuthProvider, type AuthProvider } from "./data/auth-fetch";
import { createDemoSource } from "./data/demo-source";
import { createApiViewsSource, createDemoViewsSource, demoSeedViews } from "./data/views-source";
import { browserOidcDeps, createOidcSession, oidcConfigFromEnv } from "./data/oidc";
import { createScheduleSource } from "./data/schedule-source";
import { createI18n, type UiLocale } from "./i18n";
import { AuthFailure, ScheduleContainer } from "./ScheduleContainer";
import { demoSchedule } from "./demo";

const params = new URLSearchParams(location.search);
const lang = params.get("lang");
const locale: UiLocale = lang === "en" || lang === "pseudo" ? lang : "fr";
const i18n = createI18n(locale);
document.documentElement.lang = locale === "en" ? "en" : "fr";
// Tailles initiales seulement : la grille remplit l'espace restant (CSS) et son ResizeObserver prend le relais.
const widthPx = window.innerWidth;
const heightPx = window.innerHeight;
const root = createRoot(document.getElementById("root")!);

function renderApi(auth: AuthProvider, onLogout?: () => void) {
  const api = createClient({ baseUrl: "", fetch: createAuthFetch(auth) });
  const wsBase = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  const source = createScheduleSource({ api, realtime: { wsBase, onError: (err) => console.warn(err) } });
  root.render(<ScheduleContainer i18n={i18n} source={source} views={createApiViewsSource(api)} widthPx={widthPx} heightPx={heightPx} {...(onLogout ? { onLogout } : {})} />);
}

if (params.get("demo") === "1") {
  const source = createDemoSource(demoSchedule(todayIn("Europe/Paris", new Date())));
  root.render(<ScheduleContainer i18n={i18n} source={source} views={createDemoViewsSource(demoSeedViews())} widthPx={widthPx} heightPx={heightPx} />);
} else if (import.meta.env.VITE_AUTH_MODE === "oidc") {
  const session = createOidcSession(oidcConfigFromEnv(import.meta.env, location.origin), browserOidcDeps());
  session.start().then(
    (outcome) => { if (outcome === "authenticated") renderApi(oidcAuthProvider(session), () => void session.logout()); },
    (err) => {
      console.warn(err);
      root.render(<AuthFailure i18n={i18n} onRetry={() => void session.login()} />);
    },
  );
} else {
  renderApi(devAuthProvider(import.meta.env));
}

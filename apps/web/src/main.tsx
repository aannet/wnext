// Point d'entrée de l'écran. Langue : ?lang=en|pseudo, français par défaut.
//  * Par défaut : branché sur l'API (proxy Vite /api) avec temps réel. Identité selon VITE_AUTH_MODE (src/data/auth-fetch.ts) :
//    `dev` (défaut) en-têtes x-dev-* ; `oidc` écran de connexion WNEXT (bouton « Se connecter » = flux OIDC PKCE, src/data/oidc.ts)
//    tant qu'il n'y a pas de session. Le profil (GET /me : nom, rôle) est chargé avant la coque (shell/), qui en tire l'en-tête
//    (« Bonjour {prénom} ») et le masquage des actions réservées (import et réglages : owner, admin ; écritures du planning :
//    owner, admin, project_manager).
//  * ?demo=1 : démo locale sans API ni connexion (src/demo.ts), utilisateur fictif « Alec » ; les gestes s'y appliquent
//    localement (src/data/demo-source.ts), quelques notifications locales (src/data/notifications-source.ts).
//  * Le Planning est démonté quand on le quitte ; son zoom et sa position sont gardés ici (`memory`, PO-02).
import { todayIn } from "@wnext/engine";
import { createRoot } from "react-dom/client";
import { createClient } from "./api/client.gen";
import { createAuthFetch, devAuthProvider, oidcAuthProvider, type AuthProvider } from "./data/auth-fetch";
import { createDemoSource } from "./data/demo-source";
import { createApiImportSource, createDemoImportSource, demoImportSnapshot } from "./data/import-source";
import { createApiNotificationsSource, createDemoNotificationsSource, demoNotifications } from "./data/notifications-source";
import { createApiViewsSource, createDemoViewsSource, demoSeedViews } from "./data/views-source";
import { browserOidcDeps, createOidcSession, oidcConfigFromEnv, type OidcSession } from "./data/oidc";
import { createScheduleSource } from "./data/schedule-source";
import { createI18n, type UiLocale } from "./i18n";
import { createApiProjectsSource, createDemoProjectsSource } from "./data/projects-source";
import { ScheduleContainer } from "./ScheduleContainer";
import { ProjectsScreen } from "./projects/projects-screen";
import { canEditProjects, scheduleProjectOf } from "./projects/projects-model";
import { createApiPeopleSource, createApiReferenceSource, createDemoDirectory } from "./data/people-source";
import { canEditPeople } from "./people/people-model";
import { PeopleScreen } from "./people/people-screen";
import { SettingsScreen } from "./settings/settings-screen";
import type { ScheduleMemory } from "./ScheduleScreen";
import { demoSchedule, demoTasks } from "./demo";
import { App } from "./shell/app";
import { canAdminister, canEditSchedule, demoMe, loadMe, type MeState } from "./shell/me";
import { browserRouter } from "./shell/router";
import { LoginFailure, LoginScreen } from "./shell/screens";

const params = new URLSearchParams(location.search);
const lang = params.get("lang");
const locale: UiLocale = lang === "en" || lang === "pseudo" ? lang : "fr";
const i18n = createI18n(locale);
document.documentElement.lang = locale === "en" ? "en" : "fr";
// Tailles initiales seulement : la grille remplit l'espace restant (CSS) et son ResizeObserver prend le relais.
const widthPx = window.innerWidth;
const heightPx = window.innerHeight;
const root = createRoot(document.getElementById("root")!);
const router = browserRouter();

function renderApi(makeAuth: (onSessionLost: () => void) => AuthProvider, session?: OidcSession) {
  let show: (me: MeState) => void = () => {};
  const api = createClient({ baseUrl: "", fetch: createAuthFetch(makeAuth(() => show({ status: "unauthenticated" }))) });
  const wsBase = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  const notifications = createApiNotificationsSource(api);
  const source = createScheduleSource({ api, realtime: { wsBase, onError: (err) => console.warn(err), onNotifications: (n) => notifications.pushUnread(n) } });
  const views = createApiViewsSource(api);
  const imports = createApiImportSource(api);
  const projects = createApiProjectsSource(api);
  const people = createApiPeopleSource(api);
  const reference = createApiReferenceSource(api);
  const memory: ScheduleMemory = {};
  const reconnect = session && (() => void session.login());
  const load = () => { show({ status: "loading" }); void loadMe(api).then(show); };
  show = (me) => root.render(
    <App i18n={i18n} router={router} me={me} notifications={notifications} onRetry={load}
      {...(session ? { onLogout: () => void session.logout() } : {})} {...(reconnect ? { onReconnect: reconnect } : {})}
      renderPlanning={(user) => (
        <ScheduleContainer i18n={i18n} source={source} views={views} widthPx={widthPx} heightPx={heightPx} readOnly={!canEditSchedule(user)} memory={memory} catalog={projects} me={user}
          {...(reconnect ? { onReconnect: reconnect } : {})} {...(canAdminister(user) ? { imports } : {})} />
      )}
      renderProjects={(user) => <ProjectsScreen i18n={i18n} source={projects} canEdit={canEditProjects(user)} editor={source} />}
      renderPeople={(user) => (
        <PeopleScreen i18n={i18n} source={people} reference={reference} account={user.account} canEdit={canEditPeople(user)} {...(canAdminister(user) ? { imports } : {})} />
      )}
      renderSettings={(user) => <SettingsScreen i18n={i18n} reference={reference} projects={projects} account={user.account} canEdit={canAdminister(user)} />} />,
  );
  load();
}

if (params.get("demo") === "1") {
  const today = todayIn("Europe/Paris", new Date());
  const demo = demoSchedule(today);
  const source = createDemoSource(demo);
  const views = createDemoViewsSource(demoSeedViews());
  const imports = createDemoImportSource(demoImportSnapshot(demo, today));
  const projects = createDemoProjectsSource(demo, { onProject: (p) => source.projectChanged?.(scheduleProjectOf(p)) }, demoTasks(demo));
  const directory = createDemoDirectory(demo, {
    today,
    onEntity: (kind, entity) => source.directoryChanged?.(kind, entity),
    onRemoved: (kind, id) => source.directoryRemoved?.(kind, id),
    onDeactivated: (id, asOf, disposition, replacementId) => source.personDeactivated?.(id, asOf, disposition, replacementId),
    memberIds: demo.people.filter((_, i) => i % 4 === 0).map((p) => p.id), // RT-040 : une personne sur quatre a un accès
  });
  const me = demoMe();
  const memory: ScheduleMemory = {};
  root.render(
    <App i18n={i18n} router={router} me={{ status: "ready", me }} notifications={createDemoNotificationsSource(demoNotifications(today))}
      renderPlanning={(user) => <ScheduleContainer i18n={i18n} source={source} views={views} widthPx={widthPx} heightPx={heightPx} imports={imports} memory={memory} catalog={projects} me={user} />}
      renderProjects={(user) => <ProjectsScreen i18n={i18n} source={projects} canEdit={canEditProjects(user)} editor={source} />}
      renderPeople={(user) => <PeopleScreen i18n={i18n} source={directory.people} reference={directory.reference} account={user.account} canEdit={canEditPeople(user)} imports={imports} />}
      renderSettings={(user) => <SettingsScreen i18n={i18n} reference={directory.reference} projects={projects} account={user.account} canEdit={canAdminister(user)} />} />,
  );
} else if (import.meta.env.VITE_AUTH_MODE === "oidc") {
  const session = createOidcSession(oidcConfigFromEnv(import.meta.env, location.origin), browserOidcDeps());
  session.restore().then(
    (outcome) => {
      if (outcome === "authenticated") renderApi((onLost) => oidcAuthProvider(session, onLost), session);
      else root.render(<LoginScreen i18n={i18n} onLogin={() => void session.login()} />);
    },
    (err) => {
      console.warn(err);
      root.render(<LoginFailure i18n={i18n} onRetry={() => void session.login()} />);
    },
  );
} else {
  renderApi(() => devAuthProvider(import.meta.env));
}

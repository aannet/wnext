// Point d'entrée de l'écran. Langue (PO-16, resolveLocale) : ?lang=en|fr|pseudo, sinon celle du compte dès que /me est lu (et
// aussitôt qu'elle change dans Réglages), sinon celle du navigateur.
//  * Par défaut : branché sur l'API (proxy Vite /api) avec temps réel. Identité selon VITE_AUTH_MODE (src/data/auth-fetch.ts) :
//    `dev` (défaut) en-têtes x-dev-* ; `oidc` écran de connexion WNEXT (bouton « Se connecter » = flux OIDC PKCE, src/data/oidc.ts)
//    tant qu'il n'y a pas de session. Le profil (GET /me : nom, rôle) est chargé avant la coque (shell/), qui en tire l'en-tête
//    (« Bonjour {prénom} ») et le masquage des actions réservées (réglages, dont l'import, seule entrée : Réglages > Import, RT-054 :
//    owner, admin, démo comprise ; écritures du planning :
//    owner, admin, project_manager).
//  * ?demo=1 : démo locale sans API ni connexion (src/demo.ts), utilisateur fictif « Alec » ; les gestes s'y appliquent
//    localement (src/data/demo-source.ts), quelques notifications locales (src/data/notifications-source.ts).
//  * Le Planning est démonté quand on le quitte ; son zoom et sa position sont gardés ici (`memory`, PO-02).
import type { AccountSettings, Me } from "@wnext/contracts";
import { todayIn } from "@wnext/engine";
import { createRoot } from "react-dom/client";
import { createClient } from "./api/client.gen";
import { createAuthFetch, devAuthProvider, oidcAuthProvider, type AuthProvider } from "./data/auth-fetch";
import { createDemoSource } from "./data/demo-source";
import { createApiImportSource, createDemoImportSource, demoImportSnapshot, type ImportSource } from "./data/import-source";
import { createApiNotificationsSource, createDemoNotificationsSource, demoNotifications } from "./data/notifications-source";
import { createApiViewsSource, createDemoViewsSource, demoSeedViews } from "./data/views-source";
import { browserOidcDeps, createOidcSession, oidcConfigFromEnv, type OidcSession } from "./data/oidc";
import { createScheduleSource } from "./data/schedule-source";
import { createI18n, htmlLang, resolveLocale, type UiLocale } from "./i18n";
import { createApiProjectsSource, createDemoProjectsSource } from "./data/projects-source";
import { createApiAccountSource, createDemoAccountSource, meAccountOf, scheduleAccountOf } from "./data/account-source";
import { ScheduleContainer } from "./ScheduleContainer";
import { ProjectsScreen } from "./projects/projects-screen";
import { canEditProjects, scheduleProjectOf } from "./projects/projects-model";
import { createApiPeopleSource, createApiReferenceSource, createDemoDirectory, type PeopleSource } from "./data/people-source";
import type { ProjectsSource } from "./data/projects-source";
import { searchSources } from "./shell/global-search";
import { canEditPeople } from "./people/people-model";
import { PeopleScreen } from "./people/people-screen";
import { SettingsScreen } from "./settings/settings-screen";
import type { ScheduleMemory } from "./ScheduleScreen";
import { demoSchedule, demoTasks } from "./demo";
import { App } from "./shell/app";
import { canAdminister, canEditSchedule, demoMe, loadMe, type MeState } from "./shell/me";
import { browserRouter, carriedSearch, hrefOf } from "./shell/router";
import { LoginFailure, LoginScreen } from "./shell/screens";

const params = new URLSearchParams(location.search);
const lang = params.get("lang");
const localeFor = (account: string | null): UiLocale => resolveLocale({ query: lang, account, browser: navigator.languages ?? [] });
let locale = localeFor(null);
let i18n = createI18n(locale);
document.documentElement.lang = htmlLang(locale);
/** Langue du compte connue (ou changée) : l'écran passe dans la langue résolue ; rien si elle ne change pas. */
function followAccountLocale(me: MeState | Me) {
  const account = "status" in me ? (me.status === "ready" ? me.me.account : null) : me.account;
  if (!account) return;
  const next = localeFor(account.defaultLocale);
  if (next === locale) return;
  locale = next;
  i18n = createI18n(next);
  document.documentElement.lang = htmlLang(next);
}
// Tailles initiales seulement : la grille remplit l'espace restant (CSS) et son ResizeObserver prend le relais.
const widthPx = window.innerWidth;
const heightPx = window.innerHeight;
const root = createRoot(document.getElementById("root")!);
const router = browserRouter();
/** Fiche d'un projet choisi dans la recherche du Planning : /projets?projet=<id>. */
const openProject = (id: string) => router.navigate("projects", { projet: id });
/** Écran Projets : fiche demandée par l'adresse (une seule fois) ; l'adresse ne la porte plus ensuite. */
const projectsProps = () => {
  const id = router.param("projet");
  return id ? { openProjectId: id, onOpenProjectHandled: () => router.clearParam("projet") } : {};
};
/** Planning : personne choisie dans la recherche d'un autre écran (/?personne=<id>, RT-059), révélée une seule fois. */
const revealProps = () => {
  const id = router.param("personne");
  return id ? { reveal: { personId: id, onDone: () => router.clearParam("personne") } } : {};
};
/** Réglages > Import (RT-054), seule entrée de l'import : lien des états vides de Personnes et Projets, pour owner et admin. */
const importLinkFor = (user: Me) => (canAdminister(user)
  ? { importLink: { href: hrefOf("settings", carriedSearch(location.search, { onglet: "import" })), onOpen: () => router.navigate("settings", { onglet: "import" }) } }
  : {});
/** Réglages : source d'import (owner, admin ; la page ne s'ouvre qu'à eux) et onglet demandé par l'adresse (une seule fois). */
const settingsProps = (user: Me, imports: ImportSource) => {
  const tab = router.param("onglet");
  if (tab) router.clearParam("onglet");
  return { ...(canAdminister(user) ? { imports } : {}), ...(tab ? { initialTab: tab } : {}) };
};
/** Recherche globale (RT-059) : personnes et projets déjà chargés par l'app ; une personne ouvre le Planning sur sa ligne. */
const searchFor = (people: PeopleSource, projects: ProjectsSource) =>
  searchSources({ people, projects, openPerson: (id) => router.navigate("planning", { personne: id }), openProject });

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
  const account = createApiAccountSource(api);
  const search = searchFor(people, projects);
  const memory: ScheduleMemory = {};
  const reconnect = session && (() => void session.login());
  const load = () => { show({ status: "loading" }); void loadMe(api).then(show); };
  // Compte écrit (RT-041, pas de temps réel) : Planning mis à jour, /me relu sans repasser par l'écran de chargement.
  const accountSaved = (s: AccountSettings) => { source.accountChanged?.(scheduleAccountOf(s)); void loadMe(api).then((m) => { if (m.status === "ready") show(m); }); };
  show = (me) => { followAccountLocale(me); render(me); };
  const render = (me: MeState) => root.render(
    <App i18n={i18n} router={router} me={me} notifications={notifications} onRetry={load} search={search}
      {...(session ? { onLogout: () => void session.logout() } : {})} {...(reconnect ? { onReconnect: reconnect } : {})}
      renderPlanning={(user) => (
        <ScheduleContainer i18n={i18n} source={source} views={views} widthPx={widthPx} heightPx={heightPx} readOnly={!canEditSchedule(user)} memory={memory} catalog={projects} me={user} onOpenProject={openProject}
          {...(reconnect ? { onReconnect: reconnect } : {})} {...revealProps()} />
      )}
      renderProjects={(user) => <ProjectsScreen i18n={i18n} source={projects} canEdit={canEditProjects(user)} editor={source} {...projectsProps()} {...importLinkFor(user)} />}
      renderPeople={(user) => (
        <PeopleScreen i18n={i18n} source={people} reference={reference} account={user.account} canEdit={canEditPeople(user)} ownOnly={user.role === "member"} {...importLinkFor(user)} />
      )}
      renderSettings={(user) => <SettingsScreen i18n={i18n} reference={reference} projects={projects} account={account} onAccountSaved={accountSaved} canEdit={canAdminister(user)} {...settingsProps(user, imports)} />} />,
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
  let me = demoMe();
  const account = createDemoAccountSource({ ...me.account, version: 1, capacityThresholds: demo.account.capacityThresholds });
  const accountSaved = (s: AccountSettings) => { me = { ...me, account: meAccountOf(s) }; source.accountChanged?.(scheduleAccountOf(s)); renderDemo(); };
  const memory: ScheduleMemory = {};
  const search = searchFor(directory.people, projects);
  const renderDemo = () => { followAccountLocale(me); renderDemoApp(); };
  const renderDemoApp = () => root.render(
    <App i18n={i18n} router={router} me={{ status: "ready", me }} notifications={createDemoNotificationsSource(demoNotifications(today))} search={search}
      renderPlanning={(user) => <ScheduleContainer i18n={i18n} source={source} views={views} widthPx={widthPx} heightPx={heightPx} memory={memory} catalog={projects} me={user} onOpenProject={openProject} {...revealProps()} />}
      renderProjects={(user) => <ProjectsScreen i18n={i18n} source={projects} canEdit={canEditProjects(user)} editor={source} {...projectsProps()} {...importLinkFor(user)} />}
      renderPeople={(user) => <PeopleScreen i18n={i18n} source={directory.people} reference={directory.reference} account={user.account} canEdit={canEditPeople(user)} {...importLinkFor(user)} />}
      renderSettings={(user) => <SettingsScreen i18n={i18n} reference={directory.reference} projects={projects} account={account} onAccountSaved={accountSaved} canEdit={canAdminister(user)} {...settingsProps(user, imports)} />} />,
  );
  renderDemo();
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

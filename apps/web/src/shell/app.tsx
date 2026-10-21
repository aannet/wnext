// Coque applicative : en-tête commun, puis la page de la route courante. Planning est fourni par l'appelant (renderPlanning,
// qui détient la source de données) ; Projets, Personnes et Réglages sont fournis de même (une page absente : « bientôt »). Les droits d'affichage
// viennent de GET /me (état `me`) : Réglages n'apparaît que pour owner et admin.
// La page Planning est démontée quand on la quitte (sa source se rearrête et redémarre) : le défilement, le zoom et l'historique
// d'annulation repartent de zéro au retour.
import type { I18n } from "@lingui/core";
import type { Me } from "@wnext/contracts";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { NotificationsSource } from "../data/notifications-source";
import { AppHeader, ROUTE_TITLE_KEY } from "./app-header";
import { canAdminister, type MeState } from "./me";
import type { RouteId, Router } from "./router";
import { ComingSoon, NotFound, ProfileError, ProfileLoading, SessionExpired } from "./screens";

export interface AppProps {
  i18n: I18n;
  router: Router;
  me: MeState;
  renderPlanning(me: Me): ReactNode;
  /** Page Projets (lot L-F1) ; absente : page « bientôt disponible ». */
  renderProjects?(me: Me): ReactNode;
  /** Page Personnes (lot L-F2) ; absente : page « bientôt disponible ». */
  renderPeople?(me: Me): ReactNode;
  /** Page Réglages (lot L-F2, owner et admin) ; absente : page « bientôt disponible ». */
  renderSettings?(me: Me): ReactNode;
  notifications?: NotificationsSource;
  /** Session à fermer (OIDC) : menu utilisateur avec Déconnexion. */
  onLogout?: () => void;
  /** Session expirée : nouvelle connexion (OIDC) ; absent : recharge la page. */
  onReconnect?: () => void;
  /** Profil non chargé : nouvel essai. */
  onRetry?: () => void;
}

const reload = () => globalThis.location.reload();

export function App({ i18n, router, me, renderPlanning, renderProjects, renderPeople, renderSettings, notifications, onLogout, onReconnect, onRetry }: AppProps) {
  const route = useSyncExternalStore(router.subscribe, router.current);
  const previous = useRef<RouteId | null | undefined>(undefined);
  const ready = me.status === "ready";
  const title = route ? i18n._(ROUTE_TITLE_KEY[route]) : i18n._("shell.notfound.title");
  useEffect(() => {
    if (!ready) return;
    document.title = i18n._("shell.doctitle", { page: title });
    // Changement de page (pas le premier rendu) : le titre de la page reçoit le focus, pour les lecteurs d'écran et le clavier.
    if (previous.current !== undefined && previous.current !== route) document.querySelector<HTMLElement>("main h1")?.focus({ preventScroll: true });
    previous.current = route;
  }, [route, ready, title]);

  if (me.status === "loading") return <ProfileLoading i18n={i18n} />;
  if (me.status === "unauthenticated") return <SessionExpired i18n={i18n} onReconnect={onReconnect ?? reload} />;
  if (me.status === "error") return <ProfileError i18n={i18n} onRetry={onRetry ?? reload} />;

  const user = me.me;
  // Une page réservée (Réglages) pour un rôle qui n'y a pas droit : adresse inconnue, comme si elle n'existait pas.
  const page = route === "settings" && !canAdminister(user) ? null : route;
  return (
    <div className="wn-app">
      <AppHeader i18n={i18n} me={user} route={page} href={router.href} onNavigate={router.navigate}
        {...(notifications ? { notifications } : {})} {...(onLogout ? { onLogout } : {})} />
      {page === "planning" ? renderPlanning(user)
        : page === "projects" && renderProjects ? renderProjects(user)
        : page === "people" && renderPeople ? renderPeople(user)
        : page === "settings" && renderSettings ? renderSettings(user)
        : page ? <ComingSoon i18n={i18n} titleKey={ROUTE_TITLE_KEY[page]} />
        : <NotFound i18n={i18n} href={router.href("planning")} onBack={() => router.navigate("planning")} />}
    </div>
  );
}

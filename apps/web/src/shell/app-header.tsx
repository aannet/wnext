// En-tête applicatif (RT-001, RT-003) : symbole et nom de l'app (Plus Jakarta Sans ExtraBold), navigation principale (Planning, Projets, Personnes), puis à droite le bouton
// « Rechercher » et sa pastille Ctrl K (RT-059, recherche globale : shell/global-search), la cloche des notifications, l'aide des
// raccourcis clavier (RT-064, bouton « ? », shell/shortcuts-help), l'entrée Réglages (hors navigation principale, dossier §4.1 principe 1), « Bonjour {prénom} » et l'avatar à
// initiales, qui ouvre le menu utilisateur (Déconnexion) quand une session peut être fermée.
import type { I18n } from "@lingui/core";
import type { Me } from "@wnext/contracts";
import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { NotificationsSource } from "../data/notifications-source";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, Logo, PopoverRoot } from "../design";
import type { MessageKey } from "../i18n";
import { NotificationBell, NotificationsPanel } from "../notifications/notifications-ui";
import { SearchButton } from "./global-search";
import { ShortcutsHelp } from "./shortcuts-help";
import { canAdminister, firstName, initials } from "./me";
import type { RouteId } from "./router";

export const ROUTE_TITLE_KEY: Record<RouteId, MessageKey> = {
  planning: "shell.nav.planning", projects: "shell.nav.projects", people: "shell.nav.people", settings: "shell.nav.settings",
};
const MAIN_NAV: readonly RouteId[] = ["planning", "projects", "people"];

export interface AppHeaderProps {
  i18n: I18n;
  me: Me;
  /** Page courante (null : adresse inconnue, aucun lien actif). */
  route: RouteId | null;
  href(id: RouteId): string;
  onNavigate(id: RouteId): void;
  notifications?: NotificationsSource;
  /** Session à fermer (OIDC) : fait de l'avatar un menu avec Déconnexion ; absent (dev, démo) : avatar seul. */
  onLogout?: () => void;
}

export function AppHeader({ i18n, me, route, href, onNavigate, notifications, onLogout }: AppHeaderProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const link = (id: RouteId, className?: string, label: MessageKey = ROUTE_TITLE_KEY[id], content?: ReactNode) => (
    <a href={href(id)} className={className} {...(route === id ? { "aria-current": "page" as const } : {})} onClick={(e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // nouvel onglet : laissé au navigateur
      e.preventDefault();
      onNavigate(id);
    }}>{content ?? t(label)}</a>
  );
  return (
    <header className="wn-appheader">
      {link("planning", "wn-brand", "shell.brand", <><Logo size={20} /><span className="wn-brand-text">{t("shell.brand")}</span></>)}
      <nav aria-label={t("shell.nav.label")} className="wn-nav">
        {MAIN_NAV.map((id) => <span key={id}>{link(id)}</span>)}
      </nav>
      <div className="wn-appheader-end">
        <SearchButton i18n={i18n} />
        {notifications && <NotificationsMenu i18n={i18n} source={notifications} />}
        <ShortcutsHelp i18n={i18n} />
        {canAdminister(me) && link("settings", "wn-settings-link")}
        <span className="wn-greeting">{t("shell.greeting", { name: firstName(me.user.name) })}</span>
        <UserMenu i18n={i18n} me={me} {...(onLogout ? { onLogout } : {})} />
      </div>
    </header>
  );
}

/** Cloche et panneau : la cloche est le déclencheur du popover de Base UI, le panneau s'ouvre sous elle. */
export function NotificationsMenu({ i18n, source }: { i18n: I18n; source: NotificationsSource }) {
  const [open, setOpen] = useState(false);
  const bell = useRef<HTMLButtonElement>(null);
  return (
    <PopoverRoot open={open} onOpenChange={(next, details) => {
      setOpen(next);
      if (!next && details.reason !== "outside-press") bell.current?.focus();
    }}>
      <NotificationBell i18n={i18n} source={source} buttonRef={bell} />
      {open && <NotificationsPanel i18n={i18n} source={source} onClose={() => { setOpen(false); bell.current?.focus(); }} />}
    </PopoverRoot>
  );
}

function UserMenu({ i18n, me, onLogout }: { i18n: I18n; me: Me; onLogout?: () => void }) {
  const short = initials(me.user.name);
  const avatar = <span className="wn-avatar" aria-hidden="true">{short}</span>;
  if (!onLogout) return avatar;
  // Le nom accessible commence par les initiales visibles (WCAG 2.5.3, PO-14) : la commande vocale « AA » trouve le bouton.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="wn-avatar-button" aria-label={i18n._("shell.user.menu", { initials: short, name: me.user.name })}>{avatar}</DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-[220px]">
        <DropdownMenuGroup>
          <DropdownMenuLabel><strong className="text-form text-text">{me.user.name}</strong><br />{me.user.email}</DropdownMenuLabel>
          <DropdownMenuItem onClick={onLogout}>{i18n._("shell.user.logout")}</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

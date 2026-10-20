// En-tête applicatif (RT-001, RT-003) : nom de l'app, navigation principale (Planning, Projets, Personnes), puis à droite la cloche
// des notifications, l'entrée Réglages (hors navigation principale, dossier §4.1 principe 1), « Bonjour {prénom} » et l'avatar à
// initiales, qui ouvre le menu utilisateur (Déconnexion) quand une session peut être fermée.
import type { I18n } from "@lingui/core";
import type { Me } from "@wnext/contracts";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { NotificationsSource } from "../data/notifications-source";
import type { MessageKey } from "../i18n";
import { NotificationBell, NotificationsPanel } from "../notifications/notifications-ui";
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
  const link = (id: RouteId, className?: string, label: MessageKey = ROUTE_TITLE_KEY[id]) => (
    <a href={href(id)} className={className} {...(route === id ? { "aria-current": "page" as const } : {})} onClick={(e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // nouvel onglet : laissé au navigateur
      e.preventDefault();
      onNavigate(id);
    }}>{t(label)}</a>
  );
  return (
    <header className="wn-appheader">
      {link("planning", "wn-brand", "shell.brand")}
      <nav aria-label={t("shell.nav.label")} className="wn-nav">
        {MAIN_NAV.map((id) => <span key={id}>{link(id)}</span>)}
      </nav>
      <div className="wn-appheader-end">
        {notifications && <NotificationsMenu i18n={i18n} source={notifications} />}
        {canAdminister(me) && link("settings", "wn-settings-link")}
        <span className="wn-greeting">{t("shell.greeting", { name: firstName(me.user.name) })}</span>
        <UserMenu i18n={i18n} me={me} {...(onLogout ? { onLogout } : {})} />
      </div>
    </header>
  );
}

/** Cloche et panneau : même composants et même comportement qu'avant, montés dans l'en-tête (le panneau s'ouvre sous la cloche). */
export function NotificationsMenu({ i18n, source }: { i18n: I18n; source: NotificationsSource }) {
  const [open, setOpen] = useState(false);
  const bell = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); bell.current?.focus(); };
  return (
    <>
      <NotificationBell i18n={i18n} source={source} open={open} buttonRef={bell} onToggle={() => (open ? close() : setOpen(true))} />
      {open && <div className="wn-header-panel"><NotificationsPanel i18n={i18n} source={source} onClose={close} /></div>}
    </>
  );
}

function UserMenu({ i18n, me, onLogout }: { i18n: I18n; me: Me; onLogout?: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const item = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    item.current?.focus();
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const avatar = <span className="wn-avatar" aria-hidden="true">{initials(me.user.name)}</span>;
  if (!onLogout) return avatar;
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return (
    <div ref={root} className="wn-user" onKeyDown={(e) => { if (open && e.key === "Escape") { e.preventDefault(); close(); } }}>
      <button ref={trigger} type="button" className="wn-avatar-button" aria-haspopup="menu" aria-expanded={open}
        aria-label={i18n._("shell.user.menu", { name: me.user.name })} onClick={() => (open ? setOpen(false) : setOpen(true))}>{avatar}</button>
      {open && (
        <div className="wn-user-popover">
          <p className="wn-user-identity"><strong>{me.user.name}</strong><br />{me.user.email}</p>
          <div role="menu" className="wn-menu" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
            <button ref={item} type="button" role="menuitem" onClick={onLogout}>{i18n._("shell.user.logout")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

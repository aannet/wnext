// Écran Réglages (lot L-F2 : RT-012 partie Réglages ; owner et admin, la coque masque la page aux autres rôles). Sections en onglets :
// Équipes (= départements, décision Q4), Rôles, Clients (même gestion que l'écran Projets), Types de congé, Jours fériés (par
// pays) et Compte (en lecture : aucune route d'écriture du compte).
import type { I18n } from "@lingui/core";
import type { Client, Me } from "@wnext/contracts";
import { useState } from "react";
import type { ReferenceSource } from "../data/people-source";
import type { ProjectsSource } from "../data/projects-source";
import type { MessageKey } from "../i18n";
import { ClientsSection } from "../projects/clients-section";
import { useLoad } from "../projects/use-load";
import { AccountSection } from "./account-section";
import { HolidaysSection } from "./holidays-section";
import { NamedListSection } from "./named-list-section";
import { TimeoffTypesSection } from "./timeoff-types-section";

export interface SettingsScreenProps {
  i18n: I18n;
  reference: ReferenceSource;
  projects: ProjectsSource;
  account: Me["account"];
  canEdit: boolean;
}

const TABS = ["teams", "roles", "clients", "timeoff", "holidays", "account"] as const;
type Tab = (typeof TABS)[number];
const TAB_KEY: Record<Tab, MessageKey> = {
  teams: "settings.tab.teams", roles: "settings.tab.roles", clients: "settings.tab.clients", timeoff: "settings.tab.timeoff",
  holidays: "settings.tab.holidays", account: "settings.tab.account",
};

export function SettingsScreen({ i18n, reference, projects, account, canEdit }: SettingsScreenProps) {
  const t = (k: MessageKey) => i18n._(k);
  const [tab, setTab] = useState<Tab>("teams");
  const clients = useLoad(() => projects.listClients(), "settings-clients");
  const move = (from: Tab, delta: number) => {
    const next = TABS[(TABS.indexOf(from) + delta + TABS.length) % TABS.length]!;
    setTab(next);
    document.getElementById(`wn-stab-${next}`)?.focus();
  };
  return (
    <main className="wn-page wn-settings">
      <div className="wn-subheader">
        <h1 tabIndex={-1} className="wn-subheader-title">{t("shell.nav.settings")}</h1>
        <div role="tablist" aria-label={t("settings.tabs.label")} className="wn-tabs">
          {TABS.map((id) => (
            <button key={id} type="button" role="tab" id={`wn-stab-${id}`} aria-selected={tab === id} aria-controls={`wn-stabpanel-${id}`} tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight") { e.preventDefault(); move(id, 1); }
                else if (e.key === "ArrowLeft") { e.preventDefault(); move(id, -1); }
              }}>
              {t(TAB_KEY[id])}
            </button>
          ))}
        </div>
      </div>
      <div role="tabpanel" id={`wn-stabpanel-${tab}`} aria-labelledby={`wn-stab-${tab}`}>
        {tab === "teams" && <NamedListSection i18n={i18n} store={reference.departments} canEdit={canEdit} headingKey="settings.teams.title" newLabel="settings.teams.new" empty="settings.teams.empty" />}
        {tab === "roles" && <NamedListSection i18n={i18n} store={reference.roles} canEdit={canEdit} headingKey="settings.roles.title" newLabel="settings.roles.new" empty="settings.roles.empty" />}
        {tab === "clients" && (clients.state.status === "ready"
          ? <ClientsSection i18n={i18n} source={projects} clients={clients.state.data} canEdit={canEdit}
              onCreated={(c: Client) => clients.update((d) => (d.some((x) => x.id === c.id) ? d : [...d, c]))}
              onRenamed={(c: Client) => clients.update((d) => d.map((x) => (x.id === c.id ? c : x)))} />
          : clients.state.status === "error"
            ? <p role="alert" className="wn-error">{t("people.error.load")} <button type="button" onClick={clients.reload}>{t("people.retry")}</button></p>
            : <p className="wn-muted" role="status">{t("people.loading")}</p>)}
        {tab === "timeoff" && <TimeoffTypesSection i18n={i18n} store={reference.timeoffTypes} canEdit={canEdit} />}
        {tab === "holidays" && <HolidaysSection i18n={i18n} store={reference.holidays} canEdit={canEdit} />}
        {tab === "account" && <AccountSection i18n={i18n} account={account} />}
      </div>
    </main>
  );
}

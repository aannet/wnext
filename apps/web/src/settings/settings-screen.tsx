// Écran Réglages (lot L-F2 : RT-012 partie Réglages ; owner et admin, la coque masque la page aux autres rôles). Sections en onglets :
// Équipes (= départements, décision Q4), Rôles, Clients (même gestion que l'écran Projets), Types de congé, Jours fériés (par
// pays) et Compte (RT-041 : réglages du compte, modifiables par owner et admin).
import type { I18n } from "@lingui/core";
import type { AccountSettings, Client } from "@wnext/contracts";
import { useState } from "react";
import type { AccountSource } from "../data/account-source";
import type { ReferenceSource } from "../data/people-source";
import type { ProjectsSource } from "../data/projects-source";
import type { MessageKey } from "../i18n";
import { ClientsSection } from "../projects/clients-section";
import { useLoad } from "../projects/use-load";
import { AccountSection } from "./account-section";
import { HolidaysSection } from "./holidays-section";
import { NamedListSection } from "./named-list-section";
import { TimeoffTypesSection } from "./timeoff-types-section";
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "../design";

export interface SettingsScreenProps {
  i18n: I18n;
  reference: ReferenceSource;
  projects: ProjectsSource;
  /** Réglages du compte (GET et PATCH /account). */
  account: AccountSource;
  /** Réglages du compte enregistrés, ou relus après un conflit : l’appelant relit /me et met à jour le Planning (pas de temps réel pour le compte). */
  onAccountSaved?(settings: AccountSettings): void;
  canEdit: boolean;
}

const TABS = ["teams", "roles", "clients", "timeoff", "holidays", "account"] as const;
type Tab = (typeof TABS)[number];
const TAB_KEY: Record<Tab, MessageKey> = {
  teams: "settings.tab.teams", roles: "settings.tab.roles", clients: "settings.tab.clients", timeoff: "settings.tab.timeoff",
  holidays: "settings.tab.holidays", account: "settings.tab.account",
};

export function SettingsScreen({ i18n, reference, projects, account, onAccountSaved, canEdit }: SettingsScreenProps) {
  const t = (k: MessageKey) => i18n._(k);
  const [tab, setTab] = useState<Tab>("teams");
  const clients = useLoad(() => projects.listClients(), "settings-clients");
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} render={<main className="wn-page wn-settings" />}>
      <div className="wn-subheader">
        <h1 tabIndex={-1} className="wn-subheader-title">{t("shell.nav.settings")}</h1>
        <TabsList aria-label={t("settings.tabs.label")}>
          {TABS.map((id) => <TabsTrigger key={id} value={id}>{t(TAB_KEY[id])}</TabsTrigger>)}
        </TabsList>
      </div>
      <TabsContent value={tab}>
        {tab === "teams" && <NamedListSection i18n={i18n} store={reference.departments} canEdit={canEdit} headingKey="settings.teams.title" newLabel="settings.teams.new" empty="settings.teams.empty" />}
        {tab === "roles" && <NamedListSection i18n={i18n} store={reference.roles} canEdit={canEdit} headingKey="settings.roles.title" newLabel="settings.roles.new" empty="settings.roles.empty" />}
        {tab === "clients" && (clients.state.status === "ready"
          ? <ClientsSection i18n={i18n} source={projects} clients={clients.state.data} canEdit={canEdit}
              onCreated={(c: Client) => clients.update((d) => (d.some((x) => x.id === c.id) ? d : [...d, c]))}
              onRenamed={(c: Client) => clients.update((d) => d.map((x) => (x.id === c.id ? c : x)))} />
          : clients.state.status === "error"
            ? <p role="alert" className="wn-error">{t("people.error.load")} <Button size="sm" type="button" onClick={clients.reload}>{t("people.retry")}</Button></p>
            : <p className="wn-muted" role="status">{t("people.loading")}</p>)}
        {tab === "timeoff" && <TimeoffTypesSection i18n={i18n} store={reference.timeoffTypes} canEdit={canEdit} />}
        {tab === "holidays" && <HolidaysSection i18n={i18n} store={reference.holidays} canEdit={canEdit} />}
        {tab === "account" && <AccountSection i18n={i18n} source={account} canEdit={canEdit} {...(onAccountSaved ? { onSaved: onAccountSaved } : {})} />}
      </TabsContent>
    </Tabs>
  );
}

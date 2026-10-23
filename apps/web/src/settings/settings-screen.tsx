// Écran Réglages (lot L-F2 : RT-012 partie Réglages ; owner et admin, la coque masque la page aux autres rôles). Sections en onglets :
// Équipes (= départements, décision Q4), Rôles, Clients (seul endroit où ils se gèrent, RT-053), Types de congé, Jours fériés (par
// pays) et Compte (RT-041 : réglages du compte, modifiables par owner et admin), puis Import (recette n°4, D9 : RT-054), seule
// entrée de l'import CSV, présente quand l'appelant fournit la source d'import (owner et admin).
import type { I18n } from "@lingui/core";
import type { AccountSettings, Client } from "@wnext/contracts";
import { useRef, useState } from "react";
import type { AccountSource } from "../data/account-source";
import type { ImportSource } from "../data/import-source";
import { ImportDialog } from "../imports/import-dialog";
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
  /** Import CSV (owner, admin) : section Import ; absent : pas d'onglet. */
  imports?: ImportSource;
  /** Onglet ouvert au montage (lien « Importer » d'un état vide : ?onglet=import) ; inconnu ou indisponible : Équipes. */
  initialTab?: string;
}

const TABS = ["teams", "roles", "clients", "timeoff", "holidays", "account", "import"] as const;
type Tab = (typeof TABS)[number];
const TAB_KEY: Record<Tab, MessageKey> = {
  teams: "settings.tab.teams", roles: "settings.tab.roles", clients: "settings.tab.clients", timeoff: "settings.tab.timeoff",
  holidays: "settings.tab.holidays", account: "settings.tab.account", import: "settings.tab.import",
};

export function SettingsScreen({ i18n, reference, projects, account, onAccountSaved, canEdit, imports, initialTab }: SettingsScreenProps) {
  const t = (k: MessageKey) => i18n._(k);
  const tabs = TABS.filter((id) => id !== "import" || imports !== undefined);
  const [tab, setTab] = useState<Tab>(() => tabs.find((id) => id === initialTab) ?? "teams");
  const clients = useLoad(() => projects.listClients(), "settings-clients");
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} render={<main className="wn-page wn-settings" />}>
      <div className="wn-subheader">
        <h1 tabIndex={-1} className="wn-subheader-title">{t("shell.nav.settings")}</h1>
        <TabsList aria-label={t("settings.tabs.label")}>
          {tabs.map((id) => <TabsTrigger key={id} value={id}>{t(TAB_KEY[id])}</TabsTrigger>)}
        </TabsList>
      </div>
      <TabsContent value={tab}>
        {tab === "teams" && <NamedListSection i18n={i18n} store={reference.departments} canEdit={canEdit} headingKey="settings.teams.title" newLabel="settings.teams.new" empty="settings.teams.empty" />}
        {tab === "roles" && <NamedListSection i18n={i18n} store={reference.roles} canEdit={canEdit} headingKey="settings.roles.title" newLabel="settings.roles.new" empty="settings.roles.empty" />}
        {tab === "clients" && (clients.state.status === "ready"
          ? <ClientsSection i18n={i18n} source={projects} clients={clients.state.data} canEdit={canEdit}
              onCreated={(c: Client) => clients.update((d) => (d.some((x) => x.id === c.id) ? d : [...d, c]))}
              onRenamed={(c: Client) => clients.update((d) => d.map((x) => (x.id === c.id ? c : x)))}
              onDeleted={(c: Client) => clients.update((d) => d.filter((x) => x.id !== c.id))} />
          : clients.state.status === "error"
            ? <p role="alert" className="wn-error">{t("people.error.load")} <Button size="sm" type="button" onClick={clients.reload}>{t("people.retry")}</Button></p>
            : <p className="wn-muted" role="status">{t("people.loading")}</p>)}
        {tab === "timeoff" && <TimeoffTypesSection i18n={i18n} store={reference.timeoffTypes} canEdit={canEdit} />}
        {tab === "holidays" && <HolidaysSection i18n={i18n} store={reference.holidays} canEdit={canEdit} />}
        {tab === "account" && <AccountSection i18n={i18n} source={account} canEdit={canEdit} {...(onAccountSaved ? { onSaved: onAccountSaved } : {})} />}
        {tab === "import" && imports && <ImportSection i18n={i18n} source={imports} />}
      </TabsContent>
    </Tabs>
  );
}

/** Section Import (RT-054) : ce qui s'importe, et le bouton qui ouvre la boîte d'import (focus rendu au bouton à la fermeture). */
function ImportSection({ i18n, source }: { i18n: I18n; source: ImportSource }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <section className="wn-clients" aria-labelledby="wn-import-title">
      <h2 id="wn-import-title" className="wn-panel-section">{i18n._("settings.import.title")}</h2>
      <p className="wn-muted">{i18n._("settings.import.body")}</p>
      <Button ref={button} type="button" variant="primary" aria-haspopup="dialog" onClick={() => setOpen(true)}>{i18n._("settings.import.open")}</Button>
      {open && <ImportDialog i18n={i18n} source={source} onClose={() => { setOpen(false); button.current?.focus(); }} />}
    </section>
  );
}

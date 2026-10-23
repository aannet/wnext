// Lien vers Réglages > Import (recette n°4, D9 : RT-054), depuis les états vides de Personnes et de Projets. L'appelant ne le
// fournit qu'à qui peut importer (owner, admin) ; un vrai lien (href) qu'un clic simple confie au routeur de l'app.
import type { I18n } from "@lingui/core";
import type { MouseEvent } from "react";

export interface ImportLink {
  /** Adresse de la section Import (nouvel onglet, copie du lien). */
  href: string;
  /** Navigation dans l'app (clic simple). */
  onOpen(): void;
}

export function ImportSettingsLink({ i18n, link }: { i18n: I18n; link: ImportLink }) {
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // nouvel onglet : laissé au navigateur
    e.preventDefault();
    link.onOpen();
  };
  return <a href={link.href} className="wn-empty-link" onClick={onClick}>{i18n._("import.settings.link")}</a>;
}

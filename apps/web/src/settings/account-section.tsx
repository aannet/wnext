// Compte (Réglages) : fuseau, début de semaine, langue par défaut, en LECTURE. Le contrat n'a aucune route d'écriture du compte
// (seul GET /me expose ces valeurs) : la modification arrivera avec cette route, le seuil de sous-allocation aussi (il n'est lu
// aujourd'hui que dans la réponse de GET /schedule).
import type { I18n } from "@lingui/core";
import type { Me } from "@wnext/contracts";
import { useId } from "react";
import { weekdayName } from "../people/people-model";

export function AccountSection({ i18n, account }: { i18n: I18n; account: Me["account"] }) {
  const id = useId();
  const lang = new Intl.DisplayNames([i18n.locale], { type: "language" });
  return (
    <section className="wn-clients" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="wn-panel-section">{i18n._("settings.account.title")}</h2>
      <dl className="wn-facts">
        <dt>{i18n._("settings.account.name")}</dt><dd>{account.name}</dd>
        <dt>{i18n._("settings.account.timezone")}</dt><dd>{account.timezone}</dd>
        <dt>{i18n._("settings.account.weekstart")}</dt><dd>{weekdayName(account.weekStart - 1, i18n.locale)}</dd>
        <dt>{i18n._("settings.account.locale")}</dt><dd>{lang.of(account.defaultLocale) ?? account.defaultLocale}</dd>
      </dl>
      <p className="wn-muted">{i18n._("settings.account.readonly")}</p>
    </section>
  );
}

// Écrans hors planning : pages « bientôt » (lot L-F), portail de connexion OIDC (RT-002), session expirée, erreur, adresse inconnue.
// Les écrans d'accès (connexion, session, erreur) sont seuls sur la page : pas d'en-tête applicatif, personne n'est connecté.
import type { I18n } from "@lingui/core";
import type { MessageKey } from "../i18n";
import { Button } from "../design";

/** Page encore vide : titre de la page et état « bientôt », dans l'en-tête applicatif. */
export function ComingSoon({ i18n, titleKey }: { i18n: I18n; titleKey: MessageKey }) {
  const page = i18n._(titleKey);
  return (
    <main className="wn-page">
      <h1 tabIndex={-1} className="wn-subheader-title">{page}</h1>
      <section className="wn-soon" aria-labelledby="wn-soon-title">
        <h2 id="wn-soon-title">{i18n._("shell.soon.heading")}</h2>
        <p>{i18n._("shell.soon.body", { page })}</p>
      </section>
    </main>
  );
}

export function NotFound({ i18n, href, onBack }: { i18n: I18n; href: string; onBack: () => void }) {
  return (
    <main className="wn-page">
      <h1 tabIndex={-1} className="wn-subheader-title">{i18n._("shell.notfound.title")}</h1>
      <p>{i18n._("shell.notfound.body")}</p>
      <a href={href} onClick={(e) => { e.preventDefault(); onBack(); }}>{i18n._("shell.notfound.back")}</a>
    </main>
  );
}

function Gate({ i18n, title, children, busy }: { i18n: I18n; title: string; children?: React.ReactNode; busy?: boolean }) {
  return (
    <main className="wn-gate" {...(busy ? { "aria-busy": true } : {})}>
      <div className="wn-gate-card">
        <p className="wn-brand wn-gate-brand">{i18n._("shell.brand")}</p>
        <h1 tabIndex={-1}>{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** Portail de connexion (OIDC) : le bouton lance le flux PKCE existant. */
export function LoginScreen({ i18n, onLogin }: { i18n: I18n; onLogin: () => void }) {
  return (
    <Gate i18n={i18n} title={i18n._("shell.login.title")}>
      <p>{i18n._("shell.login.lead")}</p>
      <Button type="button" variant="primary" onClick={onLogin}>{i18n._("shell.login.button")}</Button>
    </Gate>
  );
}

/** Session perdue en cours d'usage (refresh refusé, 401 sur /me) : nouvelle connexion, ou rechargement hors OIDC. */
export function SessionExpired({ i18n, onReconnect }: { i18n: I18n; onReconnect: () => void }) {
  return (
    <Gate i18n={i18n} title={i18n._("shell.expired.title")}>
      <p role="alert">{i18n._("shell.expired.body")}</p>
      <Button type="button" variant="primary" onClick={onReconnect}>{i18n._("auth.retry")}</Button>
    </Gate>
  );
}

/** Chargement du profil impossible (hors 401) : nouvel essai. */
export function ProfileError({ i18n, onRetry }: { i18n: I18n; onRetry: () => void }) {
  return (
    <Gate i18n={i18n} title={i18n._("shell.error.title")}>
      <p role="alert">{i18n._("shell.error.body")}</p>
      <Button type="button" variant="primary" onClick={onRetry}>{i18n._("shell.error.retry")}</Button>
    </Gate>
  );
}

export function ProfileLoading({ i18n }: { i18n: I18n }) {
  return (
    <Gate i18n={i18n} title={i18n._("schedule.loading")} busy />
  );
}

/** Échec de la connexion OIDC (state invalide, fournisseur injoignable, échange refusé) : message et nouvel essai. */
export function LoginFailure({ i18n, onRetry }: { i18n: I18n; onRetry: () => void }) {
  return (
    <Gate i18n={i18n} title={i18n._("shell.login.title")}>
      <p role="alert">{i18n._("auth.error")}</p>
      <Button type="button" variant="primary" onClick={onRetry}>{i18n._("auth.retry")}</Button>
    </Gate>
  );
}

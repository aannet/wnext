// Aide des raccourcis clavier (RT-064, née de la décision D1 de la recette n°4) : un bouton « ? » dans l'en-tête commun, juste
// après la cloche des notifications, et la touche « ? » ouvrent une fenêtre (design/Modal) qui liste tous les raccourcis, par
// groupe (partout, grille du planning, bloc sélectionné, congé sélectionné). La liste vient de shell/shortcuts, la source des gestionnaires de touches.
//  * « ? » est ignoré dans un champ de saisie, une zone de texte, un contenteditable, une autre fenêtre modale, et quand
//    l'événement est déjà traité.
//  * Fermée, la fenêtre rend le focus au bouton (Dialog) ; ouverte au clavier sans focus utile, au bouton aussi.
import type { I18n } from "@lingui/core";
import { Fragment, useEffect, useRef, useState } from "react";
import { Button, Modal } from "../design";
import type { MessageKey } from "../i18n";
import { keyText, matches, shortcut, SHORTCUTS, type ShortcutScope } from "./shortcuts";

const SCOPES: readonly { scope: ShortcutScope; label: MessageKey }[] = [
  { scope: "global", label: "shortcuts.scope.global" },
  { scope: "planning", label: "shortcuts.scope.planning" },
  { scope: "block", label: "shortcuts.scope.block" },
  { scope: "timeoff", label: "shortcuts.scope.timeoff" },
];

/** Cible où « ? » est un caractère à saisir. */
function typing(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.matches("input, textarea, select") || t.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

export function ShortcutsHelp({ i18n }: { i18n: I18n }) {
  const t = (k: MessageKey) => i18n._(k);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matches("help", e) || e.defaultPrevented || typing(e.target)) return;
      if (document.querySelector('[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"]')) return;
      e.preventDefault();
      setOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const close = () => {
    setOpen(false);
    queueMicrotask(() => { if (document.activeElement === document.body) button.current?.focus({ preventScroll: true }); });
  };
  return (
    <>
      <Button ref={button} type="button" className="wn-help-open" aria-label={t("shortcuts.title")} title={t("shortcuts.title")} aria-haspopup="dialog"
        aria-keyshortcuts={shortcut("help").aria} onClick={() => setOpen(true)}>
        <span aria-hidden="true">?</span>
      </Button>
      {open && (
        <Modal title={t("shortcuts.title")} closeLabel={t("dialog.close")} onClose={close} className="wn-shortcuts">
          {SCOPES.map(({ scope, label }) => (
            <section key={scope} className="wn-shortcuts-group">
              <h3>{t(label)}</h3>
              <dl>
                {SHORTCUTS.filter((s) => s.scope === scope).map((s) => (
                  <div key={s.id} data-shortcut-id={s.id} className="wn-shortcut">
                    <dt>
                      {s.keys.map((combo, i) => (
                        <Fragment key={i}>
                          {i > 0 && <span className="wn-shortcut-or">{t("shortcuts.or")}</span>}
                          <span className="wn-shortcut-combo">{combo.map((k, j) => <kbd key={j}>{keyText(k, t)}</kbd>)}</span>
                        </Fragment>
                      ))}
                    </dt>
                    <dd>{t(s.label)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </Modal>
      )}
    </>
  );
}

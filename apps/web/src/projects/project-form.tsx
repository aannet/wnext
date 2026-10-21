// Formulaire d'un projet, partagé par la création réduite (nom, client, code, couleur, dates, statut : dossier §4.1 principe 6) et
// l'édition dans le panneau. Validation locale avant l'appel (nom, code déjà pris, couleur, dates), puis l'appelant parle à l'API ;
// son refus revient ici sous forme de message traduit (`submitError`) et, pour un code déjà pris, sous le champ concerné.
import type { I18n } from "@lingui/core";
import type { Client, ProjectDetail } from "@wnext/contracts";
import { useId, useState, useEffect } from "react";
import type { MessageKey } from "../i18n";
import { ColorField } from "./color-field";
import { STATUS_KEY, STATUSES, validateForm, type FormErrors, type FormField, type FormValues } from "./projects-model";

const NEW_CLIENT = "__new__";

export interface ProjectFormProps {
  i18n: I18n;
  mode: "create" | "edit";
  initial: FormValues;
  clients: readonly Client[];
  /** Les autres projets du compte (unicité du code). */
  others: readonly Pick<ProjectDetail, "projectCode">[];
  readOnly?: boolean;
  busy?: boolean;
  /** Erreur d'écriture déjà traduite, affichée en tête du formulaire (role=alert). */
  submitError?: string | null;
  /** Erreur de champ renvoyée par l'API (code déjà pris). */
  serverFieldErrors?: FormErrors;
  /** Libellé du bouton (défaut : Créer / Enregistrer). */
  onSubmit(values: FormValues): void;
  onCancel?(): void;
  /** Valeurs qui ont changé depuis la dernière sauvegarde (édition) : active « Enregistrer ». */
  dirtyCheck?(values: FormValues): boolean;
  /** Modifications non enregistrées (confirmation à la fermeture du drawer, RT-023, Q7). */
  onDirtyChange?(dirty: boolean): void;
}

export function ProjectForm(p: ProjectFormProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => p.i18n._(k, v);
  const id = useId();
  const [v, setV] = useState<FormValues>(p.initial);
  const [showErrors, setShowErrors] = useState(false);
  const set = <K extends keyof FormValues>(k: K, value: FormValues[K]) => setV((x) => ({ ...x, [k]: value }));
  const local = validateForm(v, p.others, p.clients);
  const errors: FormErrors = { ...(showErrors ? local : {}), ...p.serverFieldErrors };
  const fieldError = (f: FormField) => (errors[f] ? t(errors[f]!) : undefined);
  const dirty = p.dirtyCheck ? p.dirtyCheck(v) : true;
  const edited = p.dirtyCheck ? dirty : JSON.stringify(v) !== JSON.stringify(p.initial);
  const onDirty = p.onDirtyChange;
  useEffect(() => { onDirty?.(edited); }, [edited, onDirty]);
  const disabled = p.readOnly || p.busy;
  const creatingClient = v.clientId === NEW_CLIENT;

  const field = (f: FormField, label: MessageKey, control: (props: { id: string; "aria-invalid"?: true; "aria-describedby"?: string }) => React.ReactNode) => {
    const msg = fieldError(f);
    return (
      <div className="wn-field">
        <label htmlFor={`${id}-${f}`}>{t(label)}</label>
        {control({ id: `${id}-${f}`, ...(msg ? { "aria-invalid": true as const, "aria-describedby": `${id}-${f}-err` } : {}) })}
        {msg && <p id={`${id}-${f}-err`} className="wn-field-error">{msg}</p>}
      </div>
    );
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (p.readOnly) return;
    setShowErrors(true);
    const effective: FormValues = creatingClient ? { ...v, clientId: "" } : { ...v, newClientName: "" };
    const checked = validateForm(effective, p.others, p.clients);
    if (creatingClient && !v.newClientName.trim()) checked.newClientName = "projects.form.error.client_name";
    if (Object.keys(checked).length) return;
    p.onSubmit(effective);
  }

  return (
    <form className="wn-project-form" onSubmit={submit} noValidate aria-busy={p.busy || undefined}>
      {p.submitError && <p role="alert" className="wn-error">{p.submitError}</p>}
      {field("name", "projects.form.name", (a) => (
        <input {...a} type="text" value={v.name} disabled={disabled} required maxLength={200} autoComplete="off" onChange={(e) => set("name", e.target.value)} />
      ))}
      <div className="wn-field">
        <label htmlFor={`${id}-client`}>{t("projects.form.client")}</label>
        <select id={`${id}-client`} value={creatingClient ? NEW_CLIENT : v.clientId} disabled={disabled} onChange={(e) => set("clientId", e.target.value)}>
          <option value="">{t("projects.form.client.none")}</option>
          {p.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          {!p.readOnly && <option value={NEW_CLIENT}>{t("projects.form.client.new")}</option>}
        </select>
      </div>
      {creatingClient && field("newClientName", "projects.form.client.name", (a) => (
        <input {...a} type="text" value={v.newClientName} disabled={disabled} maxLength={200} autoComplete="off" onChange={(e) => set("newClientName", e.target.value)} />
      ))}
      {field("projectCode", "projects.form.code", (a) => (
        <input {...a} type="text" value={v.projectCode} disabled={disabled} maxLength={100} autoComplete="off" onChange={(e) => set("projectCode", e.target.value)} />
      ))}
      <ColorField i18n={p.i18n} value={v.color} onChange={(c) => set("color", c)} disabled={disabled} error={fieldError("color")} errorId={`${id}-color-err`} />
      {errors.color && <p id={`${id}-color-err`} className="wn-field-error">{t(errors.color)}</p>}
      <div className="wn-field-row">
        <div className="wn-field">
          <label htmlFor={`${id}-start`}>{t("projects.form.start")}</label>
          <input id={`${id}-start`} type="date" value={v.startDate} disabled={disabled} onChange={(e) => set("startDate", e.target.value)} />
        </div>
        {field("endDate", "projects.form.end", (a) => (
          <input {...a} type="date" value={v.endDate} disabled={disabled} onChange={(e) => set("endDate", e.target.value)} />
        ))}
      </div>
      <div className="wn-field">
        <label htmlFor={`${id}-status`}>{t("projects.form.status")}</label>
        <select id={`${id}-status`} value={v.status} disabled={disabled} onChange={(e) => set("status", e.target.value as FormValues["status"])}>
          {STATUSES.map((s) => <option key={s} value={s}>{t(STATUS_KEY[s])}</option>)}
        </select>
      </div>
      {!p.readOnly && (
        <div className="wn-dialog-actions">
          <button type="submit" className="wn-primary" disabled={p.busy || !dirty}>{t(p.mode === "create" ? "projects.form.create" : "projects.form.save")}</button>
          {p.onCancel && <button type="button" onClick={p.onCancel}>{t("projects.form.cancel")}</button>}
        </div>
      )}
    </form>
  );
}

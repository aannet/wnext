// Choix de la couleur d'un projet (RT-018) : les 16 couleurs de la palette (design/project-palette), garanties lisibles
// (texte >= 4,5:1, loin du rouge de dépassement et de l'accent), et une couleur libre en #RRGGBB qui avertit au lieu d'interdire.
// Groupe de boutons radio à tabulation itinérante : une seule tabulation pour le groupe, flèches pour passer d'une teinte à l'autre.
import type { I18n } from "@lingui/core";
import { useId, useRef } from "react";
import { colorWarnings, PROJECT_PALETTE, type ColorWarning } from "../design/project-palette";
import type { MessageKey } from "../i18n";
import { blockColors } from "../schedule/block-colors";

const WARNING_KEY: Record<ColorWarning, MessageKey> = {
  invalid: "projects.color.warning.invalid",
  "low-surface-contrast": "projects.color.warning.light",
  "near-over-capacity": "projects.color.warning.red",
  "near-accent": "projects.color.warning.accent",
};

export interface ColorFieldProps {
  i18n: I18n;
  value: string;
  onChange(hex: string): void;
  disabled?: boolean;
  /** Message d'erreur déjà traduit (validation du formulaire). */
  error?: string | undefined;
  errorId?: string;
}

export function ColorField({ i18n, value, onChange, disabled = false, error, errorId }: ColorFieldProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const id = useId();
  const group = useRef<HTMLDivElement>(null);
  const current = value.trim().toUpperCase();
  const inPalette = PROJECT_PALETTE.findIndex((p) => p.hex === current);
  const warnings = inPalette >= 0 ? [] : colorWarnings(value.trim());
  const focusable = inPalette >= 0 ? inPalette : 0;

  function onKey(e: React.KeyboardEvent, index: number) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step || disabled) return;
    e.preventDefault();
    const next = (index + step + PROJECT_PALETTE.length) % PROJECT_PALETTE.length;
    onChange(PROJECT_PALETTE[next]!.hex);
    requestAnimationFrame(() => group.current?.querySelectorAll<HTMLElement>("[role=radio]")[next]?.focus());
  }

  return (
    <div className="wn-color-field">
      <div id={`${id}-label`} className="wn-field-label">{t("projects.color.label")}</div>
      <div ref={group} role="radiogroup" aria-labelledby={`${id}-label`} className="wn-swatches">
        {PROJECT_PALETTE.map((p, i) => {
          const selected = p.hex === current;
          return (
            <button key={p.hex} type="button" role="radio" aria-checked={selected} disabled={disabled} tabIndex={i === focusable ? 0 : -1}
              aria-label={t("projects.color.swatch", { hex: p.hex })} className="wn-swatch" data-selected={selected || undefined}
              style={{ background: p.hex, color: p.text }} onClick={() => onChange(p.hex)} onKeyDown={(e) => onKey(e, i)}>
              {selected ? "✓" : ""}
            </button>
          );
        })}
      </div>
      <div className="wn-color-free">
        <label htmlFor={`${id}-hex`}>{t("projects.color.free")}</label>
        <input id={`${id}-hex`} type="text" value={value} disabled={disabled} maxLength={7} spellCheck={false} autoComplete="off"
          aria-invalid={error ? true : undefined} aria-describedby={[error ? errorId : "", warnings.length ? `${id}-warn` : ""].filter(Boolean).join(" ") || undefined}
          onChange={(e) => onChange(e.target.value)} />
        <span className="wn-color-preview" aria-hidden="true" style={{ background: blockColors(value, false).background }} />
      </div>
      {warnings.length > 0 && (
        <ul id={`${id}-warn`} className="wn-color-warnings">
          {warnings.map((w) => <li key={w}>{t(WARNING_KEY[w])}</li>)}
        </ul>
      )}
    </div>
  );
}

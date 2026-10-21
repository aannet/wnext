// Combobox avec recherche (ux-ui §3.4, motif APG « combobox + listbox ») : le champ affiche le choix courant ; taper filtre
// la liste (sans casse ni accents), flèches haut / bas pour parcourir, Entrée ou clic pour choisir, Échap ferme la liste
// (sans fermer la fenêtre qui la contient) ou rend le texte du choix courant. Quitter le champ rend aussi ce texte.
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface ComboboxOption { id: string; name: string; color?: string | null }

export interface ComboboxProps {
  /** Libellé visible du champ. */
  label: string;
  value: string | null;
  options: readonly ComboboxOption[];
  onChange(id: string): void;
  placeholder?: string;
  /** Texte de la liste vide (catalogue i18n). */
  emptyLabel: string;
  disabled?: boolean;
  /** Champ focalisé à l'ouverture de la fenêtre qui le contient (data-autofocus), pas à chaque montage. */
  initialFocus?: boolean;
  /** Pastille avant le nom (couleur de projet, par exemple). */
  swatch?(o: ComboboxOption): ReactNode;
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();

export function Combobox({ label, value, options, onChange, placeholder, emptyLabel, disabled, initialFocus, swatch }: ComboboxProps) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const current = options.find((o) => o.id === value);
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const shown = useMemo(() => {
    const q = fold((query ?? "").trim());
    return q === "" ? options : options.filter((o) => fold(o.name).includes(q));
  }, [options, query]);
  const optionId = (i: number) => `${id}-opt-${i}`;

  const choose = (o: ComboboxOption | undefined) => {
    if (o) onChange(o.id);
    setQuery(null);
    setOpen(false);
  };
  const openAt = (i: number) => { setOpen(true); setActive(Math.max(0, Math.min(i, shown.length - 1))); };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = shown.length;
      if (!open) { openAt(e.key === "ArrowDown" ? Math.max(0, shown.findIndex((o) => o.id === value)) : n - 1); return; }
      if (n) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      choose(shown[active]);
    } else if (e.key === "Escape" && (open || query !== null)) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setQuery(null);
    }
  };

  return (
    <div className="wn-combobox">
      <label htmlFor={`${id}-input`}>{label}</label>
      <div className="wn-combobox-field">
        <input
          ref={input} id={`${id}-input`} type="text" role="combobox" autoComplete="off" spellCheck={false} disabled={disabled} data-autofocus={initialFocus ? "" : undefined}
          aria-autocomplete="list" aria-expanded={open && shown.length > 0} aria-controls={open && shown.length > 0 ? `${id}-list` : undefined}
          aria-activedescendant={open && shown.length ? optionId(active) : undefined} placeholder={placeholder}
          value={query ?? current?.name ?? ""}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
          onClick={() => { if (!open) openAt(Math.max(0, shown.findIndex((o) => o.id === value))); }}
          onBlur={() => { setOpen(false); setQuery(null); }}
          onKeyDown={onKeyDown}
        />
        {open && shown.length > 0 && (
          <ul id={`${id}-list`} role="listbox" aria-label={label} className="wn-combobox-list">
            {shown.map((o, i) => (
              <li key={o.id} id={optionId(i)} role="option" aria-selected={o.id === value} data-active={i === active || undefined}
                onMouseDown={(e) => { e.preventDefault(); choose(o); input.current?.focus(); }} onMouseEnter={() => setActive(i)}>
                {swatch?.(o)}{o.name}
              </li>
            ))}
          </ul>
        )}
        {open && shown.length === 0 && <div className="wn-combobox-empty">{emptyLabel}</div>}
      </div>
    </div>
  );
}

// Combobox avec recherche (ux-ui §3.4, motif APG « combobox + listbox ») sur la Combobox de Base UI (ADR-010, L-K) : le
// champ affiche le choix courant ; taper filtre la liste (sans casse ni accents), flèches haut / bas pour parcourir, Entrée
// ou clic pour choisir, Échap ferme la liste sans fermer la fenêtre qui la contient. Quitter le champ rend le texte du choix.
// La liste s'ouvre dans un portail, au-dessus des fenêtres (--z-menu) ; liste vide : message hors listbox.
import { Combobox as Base } from "@base-ui/react/combobox";
import { useId, useState, type ReactNode } from "react";

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
  /** Valeur refusée (erreur de saisie ou du serveur) : aria-invalid sur la saisie. */
  invalid?: boolean;
  /** Identifiants (séparés par des espaces) des textes qui décrivent le champ, message d'erreur compris : aria-describedby. */
  describedBy?: string;
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
const nameOf = (o: ComboboxOption) => o.name;
const sameId = (a: ComboboxOption, b: ComboboxOption) => a.id === b.id;
const matches = (o: ComboboxOption, query: string) => fold(o.name).includes(fold(query.trim()));

export function Combobox({ label, value, options, onChange, placeholder, emptyLabel, disabled, initialFocus, swatch, invalid, describedBy }: ComboboxProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  /** Texte tapé ; null : le champ montre le choix courant (au départ du champ, après un choix). */
  const [query, setQuery] = useState<string | null>(null);
  const selected = options.find((o) => o.id === value) ?? null;
  return (
    <Base.Root<ComboboxOption>
      items={options as ComboboxOption[]} value={selected} onValueChange={(o) => { setQuery(null); if (o) onChange(o.id); }}
      inputValue={query ?? selected?.name ?? ""} onInputValueChange={(v) => setQuery(v)}
      itemToStringLabel={nameOf} isItemEqualToValue={sameId} filter={matches} autoHighlight
      open={open} onOpenChange={setOpen} {...(disabled ? { disabled } : {})}
    >
      <div className="wn-combobox">
        <label htmlFor={`${id}-input`}>{label}</label>
        <div className="wn-combobox-field">
          <Base.Input
            id={`${id}-input`} spellCheck={false} onBlur={() => setQuery(null)} placeholder={placeholder} data-autofocus={initialFocus ? "" : undefined}
            aria-invalid={invalid ? true : undefined} aria-describedby={describedBy || undefined}
            // Liste ouverte : Échap la ferme et s'arrête au champ (la fenêtre parente reste ouverte). Liste fermée : Échap
            // remonte à la fenêtre, sans vider le champ ni le choix (comportement de Base UI écarté).
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              if (open) e.stopPropagation();
              else (e as typeof e & { preventBaseUIHandler(): void }).preventBaseUIHandler();
            }}
          />
        </div>
      </div>
      <Base.Portal>
        <Base.Positioner sideOffset={2} align="start" className="z-(--z-menu) outline-none">
          <Base.Popup aria-label={label}
            className="wn-combobox-popup max-h-[min(15rem,var(--available-height))] w-(--anchor-width) overflow-auto rounded-md border border-solid border-input bg-popover text-popover-foreground shadow-popover">
            <Base.Empty className="wn-combobox-empty px-2 py-1 text-muted-foreground empty:hidden">{emptyLabel}</Base.Empty>
            <Base.List className="m-0 list-none p-0 outline-none">
              {(o: ComboboxOption) => (
                <Base.Item key={o.id} value={o}
                  className="flex cursor-pointer items-center gap-2 px-2 py-1 outline-none select-none data-highlighted:bg-(--focus) data-highlighted:text-(--color-on-focus) data-selected:font-semibold">
                  {swatch?.(o)}{o.name}
                </Base.Item>
              )}
            </Base.List>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}

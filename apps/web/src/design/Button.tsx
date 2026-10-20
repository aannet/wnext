// Bouton minimal des pieds de fenêtre : primaire, secondaire, danger. Couleurs et rayons viennent des tokens.
import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger";

const BASE = "inline-flex min-h-(--control-default) cursor-pointer items-center justify-center rounded-md border border-solid px-3 font-[inherit] text-body font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default disabled:opacity-50";
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "border-accent bg-accent text-accent-fg",
  secondary: "border-border-strong bg-surface text-text",
  danger: "border-cap-over bg-cap-over text-accent-fg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: ButtonVariant }

export function Button({ variant = "secondary", type = "button", className, ...rest }: ButtonProps) {
  return <button type={type} className={`${BASE} ${VARIANTS[variant]}${className ? ` ${className}` : ""}`} {...rest} />;
}

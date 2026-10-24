// Symbole WNEXT (source : brand/logo.svg) : trois strates aux bouts arrondis et le point du jalon. Décoratif à côté du mot
// « WNEXT » (masqué aux lecteurs d'écran), il prend la couleur du texte.
export function Logo({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false" className={className}>
      <rect x="15" y="20" width="70" height="12" rx="6" />
      <rect x="15" y="44" width="45" height="12" rx="6" />
      <rect x="15" y="68" width="70" height="12" rx="6" />
      <circle cx="75" cy="50" r="6" />
    </svg>
  );
}

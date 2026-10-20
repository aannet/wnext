// Fenêtre modale : centrée sur un voile, rayon 8, ombre de popover (voir Dialog pour les règles d'accessibilité).
import { Dialog, type DialogProps } from "./Dialog";

export type ModalProps = DialogProps;

export function Modal(props: ModalProps) {
  return <Dialog variant="modal" {...props} />;
}

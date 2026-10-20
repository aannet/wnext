// Panneau latéral droit (~420 px) : mêmes règles que Modal (voile, focus piégé et rendu, Échap, bouton ×).
import { Dialog, type DialogProps } from "./Dialog";

export type DrawerProps = DialogProps;

export function Drawer(props: DrawerProps) {
  return <Dialog variant="drawer" {...props} />;
}

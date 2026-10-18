import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Observabilité usine",
  description: "Dashboard temps réel de la dark factory : coût, lignes, alertes.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <body>
        {children}
      </body>
    </html>
  );
}

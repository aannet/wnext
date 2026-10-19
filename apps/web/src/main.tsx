// Point d'entrée de l'écran (démo locale). Langue : ?lang=en|pseudo, français par défaut.
import { todayIn } from "@wnext/engine";
import { createRoot } from "react-dom/client";
import { createI18n, type UiLocale } from "./i18n";
import { ScheduleScreen } from "./ScheduleScreen";
import { demoSchedule } from "./demo";

const lang = new URLSearchParams(location.search).get("lang");
const locale: UiLocale = lang === "en" || lang === "pseudo" ? lang : "fr";
const data = demoSchedule(todayIn("Europe/Paris", new Date()));
const today = todayIn(data.account.timezone, new Date());

createRoot(document.getElementById("root")!).render(
  <ScheduleScreen i18n={createI18n(locale)} data={data} today={today} widthPx={window.innerWidth - 32} heightPx={window.innerHeight - 120} />,
);

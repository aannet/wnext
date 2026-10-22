import { z } from "zod";
import { Id, Version } from "./common";

// Réglages du compte (RT-041, PO-05) : GET /api/v1/account (tout membre authentifié) et PATCH /api/v1/account (owner ou admin,
// If-Match obligatoire, VERSION_CONFLICT avec params.currentVersion sur version périmée).
//  * Le fuseau est validé par le serveur contre pg_timezone_names (VALIDATION_FAILED, params.field = timezone).
//  * Le nom du compte est en lecture seule ici.
//  * Pas de diffusion temps réel (accounts n'a pas de change_log) : le client relit GET /me et le Schedule après écriture.

export const AccountLocale = z.enum(["fr", "en"]).meta({ id: "AccountLocale", description: "Langues proposées par défaut au compte" });
export type AccountLocale = z.infer<typeof AccountLocale>;

const weekStart = z.number().int().min(1).max(7).describe("Premier jour affiché, ISO : 1 = lundi ... 7 = dimanche (affichage seulement)");
const underPercent = z.number().min(1).max(100).describe("Sous-allocation si la charge est sous ce % de la capacité nette ; la sur-allocation est fixe à 100 % (BR-38)");

export const AccountSettings = z
  .object({
    id: Id,
    version: Version,
    name: z.string(),
    timezone: z.string().min(1).describe("Fuseau IANA du compte (accounts.timezone)"),
    weekStart,
    defaultLocale: z.string().describe("Langue par défaut du compte (BCP 47 court ; écriture : fr ou en)"),
    capacityThresholds: z.object({ underPercent }).describe("Seuils de capacité du compte"),
  })
  .meta({ id: "AccountSettings" });
export type AccountSettings = z.infer<typeof AccountSettings>;

// Champs absents = inchangés ; au moins un champ.
export const AccountPatch = z
  .object({
    timezone: z.string().min(1).max(64).describe("Fuseau IANA, validé contre pg_timezone_names"),
    weekStart,
    defaultLocale: AccountLocale,
    capacityThresholds: z.object({ underPercent }),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "corps vide" })
  .meta({ id: "AccountPatch" });
export type AccountPatch = z.infer<typeof AccountPatch>;

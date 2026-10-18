import Ajv from "ajv";
import schema from "../../schema/event.json";
import type { FactoryEvent } from "./types";

const ajv = new Ajv({ allErrors: false, strict: false });
const validateFn = ajv.compile<FactoryEvent>(schema);

export const SCHEMA_VERSION: string = (schema as { "x-schema-version": string })["x-schema-version"];

export type ValidationResult =
  | { ok: true; event: FactoryEvent }
  | { ok: false; reason: string };

/**
 * Valide un événement. Le message d'erreur ne contient jamais la valeur fautive
 * (pas de fuite de contenu sensible dans les logs d'invalides).
 */
export function validateEvent(input: unknown): ValidationResult {
  if (validateFn(input)) return { ok: true, event: input };
  const e = validateFn.errors?.[0];
  const where = e?.instancePath || "(racine)";
  const extra = e?.keyword === "additionalProperties" ? ` [${String((e.params as { additionalProperty?: string }).additionalProperty)}]` : "";
  return { ok: false, reason: `${where} ${e?.message ?? "invalide"}${extra}`.slice(0, 200) };
}

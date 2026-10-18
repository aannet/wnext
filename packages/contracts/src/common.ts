import { z } from "zod";

// Identifiant opaque : bigint côté base, toujours une chaîne côté API (pas de perte de précision en JSON).
export const Id = z.string().min(1).meta({ id: "Id", description: "Identifiant opaque (chaîne)" });
export type Id = z.infer<typeof Id>;

// Jour calendaire sans fuseau, AAAA-MM-JJ.
export const IsoDate = z.iso.date().meta({ id: "IsoDate", description: "Jour AAAA-MM-JJ, sans fuseau" });
export type IsoDate = z.infer<typeof IsoDate>;

// Version de ligne (row_version) : verrou optimiste, renvoyée comme ETag ; 409 sur version périmée (ADR-003 §5).
export const Version = z.number().int().min(1).meta({ id: "Version", description: "Version de l'entité (verrou optimiste)" });
export type Version = z.infer<typeof Version>;

// Nullable explicite (anyOf [X, null]). `X.nullable()` sur un schéma nommé produirait un allOf qui, lu strictement,
// interdit null.
export const orNull = <T extends z.ZodType>(schema: T) => z.union([schema, z.null()]);

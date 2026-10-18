import type { ApiError } from "@wnext/contracts";

/** Erreur métier portant un code stable du contrat ; la couche HTTP la convertit en ApiError (jamais de texte localisé). */
export class ApiFailure extends Error {
  constructor(
    readonly code: ApiError["code"],
    readonly params: ApiError["params"] = {},
  ) {
    super(code);
  }
}

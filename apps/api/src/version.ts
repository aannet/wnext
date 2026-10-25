// Version du produit annoncée par /api/v1/health : celle du package.json de l'API, recopiée de la racine (npm run version:set).
import { readFileSync } from "node:fs";

export const API_VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

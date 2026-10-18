import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// Le paquet contracts reste zod-only : l'extension .openapi() est appliquee ici, cote outillage.
// Elle doit etre evaluee AVANT l'import de @wnext/contracts (les schemas deja crees ne sont pas patches).
extendZodWithOpenApi(z);

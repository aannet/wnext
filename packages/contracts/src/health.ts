import { z } from "zod";

export const HealthResponse = z
  .object({
    status: z.enum(["ok", "degraded"]),
    version: z.string(),
  })
  .meta({ id: "HealthResponse" });
export type HealthResponse = z.infer<typeof HealthResponse>;

import { z } from "zod";

export const VERSION = "0.0.1";

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ProviderSchema = z.enum(["mock"]);
export type Provider = z.infer<typeof ProviderSchema>;
export const DEFAULT_PROVIDER: Provider = "mock";

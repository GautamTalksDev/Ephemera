import { MockProvider } from "./mock.js";
import type { Provider } from "./types.js";

export type ProviderName = "mock";

export const DEFAULT_PROVIDER: ProviderName = "mock";

let cached: Provider | undefined;

/**
 * Returns the configured Provider adapter.
 * Reads process.env.PROVIDER (default: "mock").
 */
export function getProvider(): Provider {
  const name = (process.env.PROVIDER ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;

  if (name !== "mock") {
    throw new Error(
      `Unknown PROVIDER "${name}". Supported: mock`,
    );
  }

  if (!cached || cached.name !== name) {
    cached = new MockProvider();
  }
  return cached;
}

/** Test/helper: drop the cached provider instance. */
export function resetProviderCache(): void {
  cached = undefined;
}

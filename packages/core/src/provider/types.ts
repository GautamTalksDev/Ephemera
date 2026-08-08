import type { PreviewSpec } from "../preview/schema.js";

export type ProviderStatusState = "provisioning" | "ready" | "failed";

export type CreateEnvironmentInput = {
  envId: string;
  spec: PreviewSpec;
  /** Required by ZeropsProvider for deterministic `pr{N}…` hostnames. */
  prNumber?: number;
};

export type CreateEnvironmentResult = {
  providerRef: string;
};

export type DeployCodeInput = {
  providerRef: string;
  repoUrl: string;
  ref: string;
  spec: PreviewSpec;
};

export type GetStatusInput = {
  providerRef: string;
};

export type GetStatusResult = {
  state: ProviderStatusState;
  publicUrl?: string;
  message?: string;
};

export type DestroyEnvironmentInput = {
  providerRef: string;
};

/**
 * Adapter boundary for ephemeral preview environments.
 *
 * IDEMPOTENCY CONTRACT (load-bearing):
 * Every method must be safe to call more than once with the same input.
 * - createEnvironment: same envId returns the same providerRef; does not double-create.
 * - deployCode: repeating deploy for the same providerRef/repo/ref is a no-op success.
 * - getStatus: pure read of current state; never mutates provisioning progress.
 * - destroyEnvironment: destroying an already-destroyed (or unknown) ref succeeds.
 *
 * Downstream orchestration may retry freely; providers must not break on duplicates.
 */
export interface Provider {
  name: string;
  createEnvironment(
    input: CreateEnvironmentInput,
  ): Promise<CreateEnvironmentResult>;
  deployCode(input: DeployCodeInput): Promise<void>;
  getStatus(input: GetStatusInput): Promise<GetStatusResult>;
  destroyEnvironment(input: DestroyEnvironmentInput): Promise<void>;
}

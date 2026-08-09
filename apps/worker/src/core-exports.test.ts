import { describe, expect, it } from "vitest";
import {
  PreviewSpecSchema,
  githubHttpsCloneUrlFromFullName,
  parsePreviewSpec,
  probePublicUrl,
  redactGitSecrets,
  type PreviewSpec,
} from "@ephemera/core";

/**
 * once.ts imports these named exports from @ephemera/core.
 * tsc can miss ESM export mismatches — fail the suite if any binding is missing.
 */
describe("@ephemera/core exports used by reconcile/once.ts", () => {
  it("provides every named runtime export", () => {
    expect(typeof probePublicUrl).toBe("function");
    expect(typeof parsePreviewSpec).toBe("function");
    expect(typeof redactGitSecrets).toBe("function");
    expect(typeof githubHttpsCloneUrlFromFullName).toBe("function");
    expect(PreviewSpecSchema).toBeTruthy();
    // type-only import must remain valid for tsc
    const _typeCheck: PreviewSpec | undefined = undefined;
    expect(_typeCheck).toBeUndefined();
  });
});

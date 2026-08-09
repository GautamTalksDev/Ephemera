import { describe, expect, it } from "vitest";
import {
  githubHttpsCloneUrl,
  githubHttpsCloneUrlFromFullName,
  InvalidRepoFullNameError,
  parseAllowedRepoOwners,
  parseRepoFullName,
  RepoOwnerNotAllowedError,
  requireRepoFullName,
} from "./repo-full-name.js";

describe("parseRepoFullName", () => {
  it("accepts owner/repo within length limits", () => {
    expect(parseRepoFullName("Acme-Org/my.repo_1")).toEqual({
      owner: "Acme-Org",
      name: "my.repo_1",
      fullName: "Acme-Org/my.repo_1",
    });
  });

  it("rejects URLs, extra path segments, and empty parts", () => {
    expect(parseRepoFullName("https://github.com/acme/app.git")).toBeNull();
    expect(parseRepoFullName("acme/app/extra")).toBeNull();
    expect(parseRepoFullName("/app")).toBeNull();
    expect(parseRepoFullName("acme/")).toBeNull();
    expect(parseRepoFullName("acme/app.git")).not.toBeNull(); // .git as name chars ok
    expect(parseRepoFullName("acme/app with space")).toBeNull();
  });
});

describe("requireRepoFullName allowlist", () => {
  it("allows any owner when allowlist is unset", () => {
    expect(requireRepoFullName("other/app").owner).toBe("other");
  });

  it("refuses owners outside EPHEMERA_ALLOWED_REPO_OWNERS", () => {
    expect(() =>
      requireRepoFullName("evil/app", { allowedOwners: ["acme", "Ephemera"] }),
    ).toThrow(RepoOwnerNotAllowedError);
    expect(
      requireRepoFullName("ACME/app", { allowedOwners: ["acme"] }).fullName,
    ).toBe("ACME/app");
  });
});

describe("githubHttpsCloneUrl", () => {
  it("builds only https://github.com/<owner>/<repo>.git", () => {
    expect(githubHttpsCloneUrl("acme", "app")).toBe(
      "https://github.com/acme/app.git",
    );
    expect(githubHttpsCloneUrlFromFullName("acme/app")).toBe(
      "https://github.com/acme/app.git",
    );
  });

  it("never accepts a URL-shaped owner/repo", () => {
    expect(() => githubHttpsCloneUrl("https://evil.com", "x")).toThrow(
      InvalidRepoFullNameError,
    );
  });
});

describe("parseAllowedRepoOwners", () => {
  it("returns null when unset or blank", () => {
    expect(parseAllowedRepoOwners(undefined)).toBeNull();
    expect(parseAllowedRepoOwners("")).toBeNull();
    expect(parseAllowedRepoOwners("  ,  ")).toBeNull();
  });

  it("splits comma/whitespace lists", () => {
    expect(parseAllowedRepoOwners("acme, Ephemera;foo")).toEqual([
      "acme",
      "Ephemera",
      "foo",
    ]);
  });
});

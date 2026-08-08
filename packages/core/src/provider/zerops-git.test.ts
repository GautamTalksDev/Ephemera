import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkoutGitRef,
  redactGitSecrets,
  withGitHubInstallationToken,
} from "./zerops.js";

describe("withGitHubInstallationToken", () => {
  it("injects x-access-token into https github URLs", () => {
    expect(
      withGitHubInstallationToken(
        "https://github.com/acme/app.git",
        "ghs_secret",
      ),
    ).toBe("https://x-access-token:ghs_secret@github.com/acme/app.git");
  });

  it("leaves local paths and non-github URLs alone", () => {
    expect(withGitHubInstallationToken("/tmp/repo", "tok")).toBe("/tmp/repo");
    expect(
      withGitHubInstallationToken("https://gitlab.com/acme/app.git", "tok"),
    ).toBe("https://gitlab.com/acme/app.git");
    expect(
      withGitHubInstallationToken("https://github.com/acme/app.git", undefined),
    ).toBe("https://github.com/acme/app.git");
  });
});

describe("redactGitSecrets", () => {
  it("redacts x-access-token URLs and explicit secrets", () => {
    const raw =
      'git remote add origin https://x-access-token:ghs_secret@github.com/acme/app.git\nalso ghs_secret';
    expect(redactGitSecrets(raw, ["ghs_secret"])).toBe(
      "git remote add origin https://x-access-token:***@github.com/acme/app.git\nalso ***",
    );
  });
});

describe("checkoutGitRef", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  it("checks out an arbitrary commit SHA (not only branch names)", async () => {
    const origin = await mkdtemp(join(tmpdir(), "ephemera-git-origin-"));
    dirs.push(origin);
    spawnSync("git", ["init"], { cwd: origin, stdio: "ignore" });
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: origin,
      stdio: "ignore",
    });
    spawnSync("git", ["config", "user.name", "test"], {
      cwd: origin,
      stdio: "ignore",
    });
    await writeFile(join(origin, "readme.txt"), "hello\n", "utf8");
    spawnSync("git", ["add", "readme.txt"], { cwd: origin, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "init"], { cwd: origin, stdio: "ignore" });
    const sha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: origin,
      encoding: "utf8",
    }).stdout.trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    // A second commit so HEAD != first SHA; fetch must target the SHA.
    await writeFile(join(origin, "readme.txt"), "bye\n", "utf8");
    spawnSync("git", ["add", "readme.txt"], { cwd: origin, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "second"], {
      cwd: origin,
      stdio: "ignore",
    });

    const dest = await mkdtemp(join(tmpdir(), "ephemera-git-dest-"));
    dirs.push(dest);
    const repoDir = join(dest, "repo");
    await checkoutGitRef({
      repoDir,
      repoUrl: origin,
      ref: sha,
    });

    const checked = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).stdout.trim();
    expect(checked).toBe(sha);
  });
});

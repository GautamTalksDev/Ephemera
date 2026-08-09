/**
 * GitHub owner/repo as stored in `repos.full_name`.
 * Owner ≤39, repo ≤100; only safe path characters (no slashes, spaces, URLs).
 */
export const REPO_FULL_NAME_RE =
  /^[A-Za-z0-9._-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export type ParsedRepoFullName = {
  owner: string;
  name: string;
  fullName: string;
};

export class InvalidRepoFullNameError extends Error {
  readonly code = "invalid_repo_full_name" as const;

  constructor(fullName: string) {
    super(
      `invalid repo fullName ${JSON.stringify(fullName)}; expected owner/repo matching ${REPO_FULL_NAME_RE}`,
    );
    this.name = "InvalidRepoFullNameError";
  }
}

export class RepoOwnerNotAllowedError extends Error {
  readonly code = "repo_owner_not_allowed" as const;

  constructor(owner: string, allowed: readonly string[]) {
    super(
      `repo owner ${JSON.stringify(owner)} is not in EPHEMERA_ALLOWED_REPO_OWNERS (${allowed.join(", ")})`,
    );
    this.name = "RepoOwnerNotAllowedError";
  }
}

export function parseRepoFullName(
  fullName: string,
): ParsedRepoFullName | null {
  const trimmed = fullName.trim();
  if (!REPO_FULL_NAME_RE.test(trimmed)) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  const owner = trimmed.slice(0, slash);
  const name = trimmed.slice(slash + 1);
  return { owner, name, fullName: `${owner}/${name}` };
}

/**
 * Parse comma/whitespace-separated owners from EPHEMERA_ALLOWED_REPO_OWNERS.
 * Returns null when unset/empty (allow all owners that pass the fullName regex).
 */
export function parseAllowedRepoOwners(
  raw: string | undefined,
): string[] | null {
  if (raw === undefined) {
    return null;
  }
  const parts = raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
}

export function getAllowedRepoOwnersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] | null {
  return parseAllowedRepoOwners(env.EPHEMERA_ALLOWED_REPO_OWNERS);
}

export function isRepoOwnerAllowed(
  owner: string,
  allowedOwners: readonly string[] | null | undefined,
): boolean {
  if (!allowedOwners || allowedOwners.length === 0) {
    return true;
  }
  const needle = owner.toLowerCase();
  return allowedOwners.some((o) => o.toLowerCase() === needle);
}

export type RequireRepoFullNameOptions = {
  /** When non-null/non-empty, owner must be on the list. */
  allowedOwners?: readonly string[] | null;
};

export function requireRepoFullName(
  fullName: string,
  options: RequireRepoFullNameOptions = {},
): ParsedRepoFullName {
  const parsed = parseRepoFullName(fullName);
  if (!parsed) {
    throw new InvalidRepoFullNameError(fullName);
  }
  if (!isRepoOwnerAllowed(parsed.owner, options.allowedOwners)) {
    throw new RepoOwnerNotAllowedError(
      parsed.owner,
      options.allowedOwners ?? [],
    );
  }
  return parsed;
}

/**
 * Clone URL from already-validated owner/name parts only.
 * Never pass a caller-supplied URL into git.
 */
export function githubHttpsCloneUrl(owner: string, name: string): string {
  const parsed = requireRepoFullName(`${owner}/${name}`);
  return `https://github.com/${parsed.owner}/${parsed.name}.git`;
}

export function githubHttpsCloneUrlFromFullName(fullName: string): string {
  const parsed = requireRepoFullName(fullName);
  return githubHttpsCloneUrl(parsed.owner, parsed.name);
}

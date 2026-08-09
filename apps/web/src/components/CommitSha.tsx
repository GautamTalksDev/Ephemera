import { useEffect, useState } from "react";

function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 7) : sha;
}

/**
 * Corner badge with the deployed commit SHA.
 * Prefers VITE_GIT_SHA (baked at build); falls back to GET /api/health → gitSha.
 */
export function CommitSha() {
  const baked = (import.meta.env.VITE_GIT_SHA as string | undefined)?.trim();
  const [sha, setSha] = useState<string | null>(baked || null);

  useEffect(() => {
    if (baked) {
      return;
    }
    let cancelled = false;
    const base = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(
      /\/$/,
      "",
    );
    const url = base ? `${base}/health` : "/api/health";
    void fetch(url)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { gitSha?: string } | null) => {
        const fromApi = body?.gitSha?.trim();
        if (!cancelled && fromApi) {
          setSha(fromApi);
        }
      })
      .catch(() => {
        /* leave unset */
      });
    return () => {
      cancelled = true;
    };
  }, [baked]);

  if (!sha) {
    return null;
  }

  return (
    <div className="commit-sha mono" title={sha}>
      {shortSha(sha)}
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  destroyEnvironment,
  fetchEnvironments,
  ttlLabel,
  type EnvironmentItem,
} from "../api.ts";
import { StateBadge } from "../components/StateBadge.tsx";

export function EnvironmentsPage() {
  const [envs, setEnvs] = useState<EnvironmentItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [destroying, setDestroying] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const rows = await fetchEnvironments();
        if (!cancelled) {
          setEnvs(rows);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "failed to load");
        }
      }
    }

    void load();
    const id = window.setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  async function onDestroy(id: string) {
    setDestroying(id);
    try {
      await destroyEnvironment(id);
      setEnvs(await fetchEnvironments());
    } catch (err) {
      setError(err instanceof Error ? err.message : "destroy failed");
    } finally {
      setDestroying(null);
    }
  }

  if (envs === null && !error) {
    return <p className="muted">Loading environments…</p>;
  }

  if (error && !envs) {
    return (
      <p className="mono" style={{ color: "var(--danger)" }}>
        {error}
      </p>
    );
  }

  if (envs && envs.length === 0) {
    return (
      <div className="empty">
        <p>
          <strong>No preview environments yet.</strong>
        </p>
        <p>1. Add a <span className="mono">preview.yml</span> to your repo (or import from compose).</p>
        <p>2. Open a PR — the webhook sets desired state only.</p>
        <p>3. Or press <strong>Run live demo</strong> to provision one now.</p>
      </div>
    );
  }

  return (
    <div>
      {error && (
        <p className="mono" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>Repo / PR</th>
            <th>Branch</th>
            <th>State</th>
            <th>URL</th>
            <th>TTL</th>
            <th>Waiting on</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {envs?.map((env) => (
            <tr key={env.id}>
              <td>
                <Link to={`/environments/${env.id}`} className="linkish">
                  <span className="mono">
                    {env.repoFullName}#{env.prNumber}
                  </span>
                </Link>
                <div className="mono muted" style={{ fontSize: 11 }}>
                  {env.id.slice(0, 8)}
                </div>
              </td>
              <td className="mono">{env.branch}</td>
              <td>
                <StateBadge state={env.actualState} />
                {env.desiredState !== "running" && (
                  <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
                    desired {env.desiredState}
                  </div>
                )}
              </td>
              <td className="mono">
                {env.publicUrl ? (
                  <a className="linkish" href={env.publicUrl} target="_blank" rel="noreferrer">
                    {env.publicUrl.replace(/^https?:\/\//, "")}
                  </a>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td className="mono">{ttlLabel(env.expiresAt)}</td>
              <td style={{ maxWidth: 280 }}>
                <span className={env.actualState === "failed" ? "err" : "muted"}>
                  {env.waitingOn}
                </span>
              </td>
              <td>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={
                    destroying === env.id ||
                    env.desiredState === "destroyed" ||
                    env.actualState === "destroyed"
                  }
                  onClick={() => void onDestroy(env.id)}
                >
                  Destroy
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

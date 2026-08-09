import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  destroyEnvironment,
  extendEnvironmentTtl,
  retryEnvironment,
  ttlLabel,
} from "../api.ts";
import { StateBadge } from "../components/StateBadge.tsx";
import { useEnvironments } from "../environments/store.tsx";
import { truncateWaitingOn, waitingOnFor } from "../waitingOn.ts";

export function EnvironmentsPage() {
  const { listIds, listError, listEnvironments, refreshList, upsert } =
    useEnvironments();
  const [error, setError] = useState<string | null>(null);
  const [destroying, setDestroying] = useState<string | null>(null);
  const [extending, setExtending] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let seq = 0;

    async function load() {
      const my = ++seq;
      try {
        await refreshList();
        if (!cancelled && my === seq) {
          setError(null);
        }
      } catch (err) {
        if (!cancelled && my === seq) {
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
  }, [refreshList]);

  const envs = listEnvironments();
  const displayError = error ?? listError;

  async function onDestroy(id: string) {
    setDestroying(id);
    try {
      await destroyEnvironment(id);
      await refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "destroy failed");
    } finally {
      setDestroying(null);
    }
  }

  async function onExtendTtl(id: string) {
    setExtending(id);
    try {
      const updated = await extendEnvironmentTtl(id);
      upsert(updated);
      await refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "extend TTL failed");
    } finally {
      setExtending(null);
    }
  }

  async function onRetry(id: string) {
    setRetrying(id);
    try {
      await retryEnvironment(id);
      await refreshList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "retry failed");
    } finally {
      setRetrying(null);
    }
  }

  if (listIds === null && !displayError) {
    return <p className="muted">Loading environments…</p>;
  }

  if (displayError && listIds === null) {
    return (
      <p className="mono" style={{ color: "var(--danger)" }}>
        {displayError}
      </p>
    );
  }

  if (listIds !== null && envs.length === 0) {
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
      {displayError && (
        <p className="mono" style={{ color: "var(--danger)" }}>
          {displayError}
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
          {envs.map((env) => {
            const waitingOn = waitingOnFor(env);
            return (
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
                  <StateBadge state={env.actualState} degraded={env.degraded} />
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
                  <span
                    className={
                      env.actualState === "failed" || env.degraded ? "err" : "muted"
                    }
                    title={waitingOn}
                    style={{
                      display: "block",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {truncateWaitingOn(waitingOn)}
                  </span>
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {env.actualState === "failed" && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ marginRight: 6 }}
                      disabled={
                        retrying === env.id ||
                        extending === env.id ||
                        destroying === env.id
                      }
                      onClick={() => void onRetry(env.id)}
                    >
                      {retrying === env.id ? "…" : "Retry"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn"
                    style={{ marginRight: 6 }}
                    disabled={
                      extending === env.id ||
                      destroying === env.id ||
                      retrying === env.id ||
                      env.desiredState === "destroyed" ||
                      env.actualState === "destroyed"
                    }
                    onClick={() => void onExtendTtl(env.id)}
                  >
                    {extending === env.id ? "…" : "Extend TTL"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={
                      destroying === env.id ||
                      extending === env.id ||
                      retrying === env.id ||
                      env.desiredState === "destroyed" ||
                      env.actualState === "destroyed"
                    }
                    onClick={() => void onDestroy(env.id)}
                  >
                    Destroy
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

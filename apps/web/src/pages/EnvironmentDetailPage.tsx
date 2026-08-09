import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  destroyEnvironment,
  extendEnvironmentTtl,
  retryEnvironment,
  ttlLabel,
  type EnvironmentEvent,
} from "../api.ts";
import { StateBadge } from "../components/StateBadge.tsx";
import { useEnvironments } from "../environments/store.tsx";
import { waitingOnFor } from "../waitingOn.ts";

export function EnvironmentDetailPage() {
  const { id = "" } = useParams();
  const { getEnvironment, eventsById, refreshOne, upsert } = useEnvironments();
  const env = getEnvironment(id);
  const events: EnvironmentEvent[] = eventsById[id] ?? [];
  const [error, setError] = useState<string | null>(null);
  const [destroying, setDestroying] = useState(false);
  const [extending, setExtending] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [loading, setLoading] = useState(!env);

  useEffect(() => {
    let cancelled = false;
    let seq = 0;

    async function load() {
      const my = ++seq;
      try {
        await refreshOne(id);
        if (!cancelled && my === seq) {
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled && my === seq) {
          setError(err instanceof Error ? err.message : "failed to load");
          setLoading(false);
        }
      }
    }

    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [id, refreshOne]);

  if (error && !env) {
    return (
      <p className="mono" style={{ color: "var(--danger)" }}>
        {error}
      </p>
    );
  }

  if (!env) {
    return (
      <p className="muted">
        {loading
          ? `Loading environment ${id.slice(0, 8)}…`
          : `Environment ${id.slice(0, 8)} not found`}
      </p>
    );
  }

  // Always from the same row as the badge — never from events/timeline.
  const waitingOn = waitingOnFor(env);

  return (
    <div>
      <p style={{ marginTop: 0 }}>
        <Link to="/" className="muted">
          ← environments
        </Link>
      </p>

      <div className="panel">
        <div className="panel-hd">
          <span className="mono">
            {env.repoFullName}#{env.prNumber}
          </span>
          <StateBadge state={env.actualState} degraded={env.degraded} />
          <span className="mono muted">{env.id}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {env.actualState === "failed" && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={retrying || destroying || extending}
                onClick={() => {
                  setRetrying(true);
                  setError(null);
                  void retryEnvironment(env.id)
                    .then(() => refreshOne(id))
                    .catch((err: unknown) =>
                      setError(
                        err instanceof Error ? err.message : "retry failed",
                      ),
                    )
                    .finally(() => setRetrying(false));
                }}
              >
                {retrying ? "Retrying…" : "Retry"}
              </button>
            )}
            <button
              type="button"
              className="btn"
              disabled={
                extending ||
                destroying ||
                retrying ||
                env.desiredState === "destroyed" ||
                env.actualState === "destroyed"
              }
              onClick={() => {
                setExtending(true);
                setError(null);
                void extendEnvironmentTtl(env.id)
                  .then((updated) => {
                    upsert(updated);
                    return refreshOne(id);
                  })
                  .catch((err: unknown) =>
                    setError(
                      err instanceof Error ? err.message : "extend TTL failed",
                    ),
                  )
                  .finally(() => setExtending(false));
              }}
            >
              {extending ? "Extending…" : "Extend TTL"}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={
                destroying ||
                extending ||
                retrying ||
                env.desiredState === "destroyed" ||
                env.actualState === "destroyed"
              }
              onClick={() => {
                setDestroying(true);
                void destroyEnvironment(env.id)
                  .then(() => refreshOne(id))
                  .catch((err: unknown) =>
                    setError(err instanceof Error ? err.message : "destroy failed"),
                  )
                  .finally(() => setDestroying(false));
              }}
            >
              Destroy
            </button>
          </div>
        </div>
        <div className="panel-bd">
          {error && (
            <p className="mono" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
              marginBottom: 16,
            }}
          >
            <div>
              <div className="muted" style={{ fontSize: 11 }}>
                BRANCH
              </div>
              <div className="mono">{env.branch}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11 }}>
                HEAD
              </div>
              <div className="mono">{env.headSha.slice(0, 12)}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11 }}>
                TTL
              </div>
              <div className="mono">{ttlLabel(env.expiresAt)}</div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11 }}>
                URL
              </div>
              <div className="mono">
                {env.publicUrl ? (
                  <a className="linkish" href={env.publicUrl} target="_blank" rel="noreferrer">
                    {env.publicUrl}
                  </a>
                ) : (
                  "—"
                )}
              </div>
            </div>
          </div>

          <div
            className="mono"
            style={{
              marginBottom: 16,
              padding: "8px 10px",
              border: "1px solid var(--line)",
              background: "#0a0c10",
            }}
          >
            state: {env.actualState}
            {env.degraded ? " (degraded)" : ""} · waiting on: {waitingOn}
          </div>

          {env.errorMessage && (
            <pre
              className="mono err"
              style={{
                marginTop: 0,
                whiteSpace: "pre-wrap",
                color: "var(--danger)",
                border: "1px solid #6b2f36",
                padding: 10,
                background: "#1a1012",
              }}
            >
              {env.errorMessage}
            </pre>
          )}

          <h2 style={{ fontSize: 13, fontWeight: 600, margin: "18px 0 8px" }}>
            Step timeline
          </h2>
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            Historical events — may describe prior steps. Current state above is
            authoritative.
          </p>
          {events.length === 0 ? (
            <p className="muted">No events yet.</p>
          ) : (
            <ul className="timeline">
              {events.map((ev) => (
                <li key={ev.id}>
                  <span className="mono muted">
                    {new Date(ev.createdAt).toISOString().replace("T", " ").slice(0, 19)}
                  </span>
                  <span className="mono">
                    {ev.level}/{ev.step}
                  </span>
                  <span className={ev.level === "error" ? "err mono" : "mono"}>
                    {ev.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

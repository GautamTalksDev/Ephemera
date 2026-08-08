import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  destroyEnvironment,
  fetchEnvironmentDetail,
  ttlLabel,
  type EnvironmentEvent,
  type EnvironmentItem,
} from "../api.ts";
import { StateBadge } from "../components/StateBadge.tsx";

export function EnvironmentDetailPage() {
  const { id = "" } = useParams();
  const [env, setEnv] = useState<EnvironmentItem | null>(null);
  const [events, setEvents] = useState<EnvironmentEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [destroying, setDestroying] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await fetchEnvironmentDetail(id);
        if (!cancelled) {
          setEnv(data.environment);
          setEvents(data.events);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "failed to load");
        }
      }
    }

    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [id]);

  if (error && !env) {
    return (
      <p className="mono" style={{ color: "var(--danger)" }}>
        {error}
      </p>
    );
  }

  if (!env) {
    return <p className="muted">Loading environment {id.slice(0, 8)}…</p>;
  }

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
          <StateBadge state={env.actualState} />
          <span className="mono muted">{env.id}</span>
          <div style={{ marginLeft: "auto" }}>
            <button
              type="button"
              className="btn btn-danger"
              disabled={
                destroying ||
                env.desiredState === "destroyed" ||
                env.actualState === "destroyed"
              }
              onClick={() => {
                setDestroying(true);
                void destroyEnvironment(env.id)
                  .then(() => fetchEnvironmentDetail(id))
                  .then((d) => {
                    setEnv(d.environment);
                    setEvents(d.events);
                  })
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
            waiting on: {env.waitingOn}
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
          {events.length === 0 ? (
            <p className="muted">
              No events yet — reconciler has not claimed this environment. Waiting on:{" "}
              <span className="mono">{env.waitingOn}</span>
            </p>
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

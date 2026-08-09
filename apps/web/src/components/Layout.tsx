import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useState } from "react";
import { useAdminToken } from "../adminToken.tsx";
import { runLiveDemo } from "../api.ts";
import { CommitSha } from "./CommitSha.tsx";

export function Layout() {
  const navigate = useNavigate();
  const { token, setToken, hasToken } = useAdminToken();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDemo() {
    setBusy(true);
    setError(null);
    try {
      const res = await runLiveDemo();
      navigate(`/environments/${res.environmentId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "demo failed";
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <CommitSha />
      <header className="topbar">
        <Link to="/" className="brand">
          EPHEMERA
        </Link>
        <nav className="nav">
          <NavLink to="/" end data-active={undefined}>
            {({ isActive }) => <span data-active={isActive ? "true" : "false"}>Environments</span>}
          </NavLink>
          <NavLink to="/import">
            {({ isActive }) => <span data-active={isActive ? "true" : "false"}>Compose import</span>}
          </NavLink>
        </nav>
        <div className="top-actions">
          <label className="admin-token-field">
            <span className="muted">Admin token</span>
            <input
              type="password"
              className="admin-token-input mono"
              placeholder="EPHEMERA_ADMIN_TOKEN"
              value={token}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !hasToken}
            onClick={() => void onDemo()}
          >
            {busy ? "Starting…" : "Run live demo"}
          </button>
        </div>
      </header>
      {!hasToken && (
        <div className="auth-banner" role="status">
          Mutations are disabled until you enter the admin token. Viewing
          environments stays public; destroy, retry, extend TTL, demo, and
          compose import require <span className="mono">Authorization: Bearer</span>.
        </div>
      )}
      {error && (
        <p className="mono" style={{ color: "var(--danger)", marginTop: 0 }}>
          {error}
        </p>
      )}
      <Outlet />
    </div>
  );
}

import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useState } from "react";
import { runLiveDemo } from "../api.ts";

export function Layout() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDemo() {
    setBusy(true);
    setError(null);
    try {
      const res = await runLiveDemo();
      navigate(`/environments/${res.environmentId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "demo failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
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
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void onDemo()}
          >
            {busy ? "Starting…" : "Run live demo"}
          </button>
        </div>
      </header>
      {error && (
        <p className="mono" style={{ color: "var(--danger)", marginTop: 0 }}>
          demo error: {error}
        </p>
      )}
      <Outlet />
    </div>
  );
}

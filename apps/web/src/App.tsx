import { useEffect, useState } from "react";
import { HealthResponseSchema, VERSION, type HealthResponse } from "@ephemera/core";

type HealthState =
  | { status: "loading" }
  | { status: "ok"; data: HealthResponse }
  | { status: "error"; message: string };

export default function App() {
  const [health, setHealth] = useState<HealthState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function loadHealth() {
      try {
        const res = await fetch("/api/health");
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json: unknown = await res.json();
        const data = HealthResponseSchema.parse(json);
        if (!cancelled) {
          setHealth({ status: "ok", data });
        }
      } catch (err) {
        if (!cancelled) {
          setHealth({
            status: "error",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }
    }

    void loadHealth();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="min-h-screen bg-stone-950 text-stone-100 flex items-center justify-center p-8">
      <div className="max-w-md w-full space-y-6">
        <h1 className="text-4xl font-semibold tracking-tight">Ephemera</h1>
        <p className="text-stone-400 text-sm">web {VERSION}</p>
        <section className="space-y-2 text-sm">
          <h2 className="text-stone-300 uppercase tracking-wider text-xs">
            API health
          </h2>
          {health.status === "loading" && (
            <p className="text-stone-500">Checking /api/health…</p>
          )}
          {health.status === "ok" && (
            <pre className="rounded bg-stone-900 border border-stone-800 p-4 overflow-x-auto">
              {JSON.stringify(health.data, null, 2)}
            </pre>
          )}
          {health.status === "error" && (
            <p className="text-red-400">Failed: {health.message}</p>
          )}
        </section>
      </div>
    </main>
  );
}

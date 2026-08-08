import { useMemo, useState } from "react";
import { importComposeYaml } from "../api.ts";

const SAMPLE = `version: "3.9"

services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: app
    volumes:
      - pgdata:/var/lib/postgresql/data

  api:
    image: node:22-bookworm-slim
    command: npm run start
    ports:
      - "3000:3000"
    depends_on:
      - db

  web:
    image: node:22-bookworm-slim
    command: npm run preview -- --port 8080
    ports:
      - "8080:8080"
    depends_on:
      - api

volumes:
  pgdata:
`;

export function ImportPage() {
  const [compose, setCompose] = useState(SAMPLE);
  const [previewYml, setPreviewYml] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const warningCount = useMemo(() => warnings.length, [warnings]);

  async function onConvert() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await importComposeYaml(compose);
      setPreviewYml(res.previewYml);
      setWarnings(res.warnings);
    } catch (err) {
      setPreviewYml("");
      setWarnings([]);
      setError(err instanceof Error ? err.message : "import failed");
    } finally {
      setBusy(false);
    }
  }

  async function onCopy() {
    if (!previewYml) {
      return;
    }
    await navigator.clipboard.writeText(previewYml);
    setCopied(true);
  }

  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>
        Paste a <span className="mono">docker-compose.yml</span>. Ephemera drafts a{" "}
        <span className="mono">preview.yml</span> and lists anything it could not map
        honestly — a silent wrong draft is worse than no importer.
      </p>

      <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void onConvert()}>
          {busy ? "Converting…" : "Generate preview.yml"}
        </button>
        <button type="button" className="btn" disabled={!previewYml} onClick={() => void onCopy()}>
          {copied ? "Copied" : "Copy preview.yml"}
        </button>
      </div>

      {error && (
        <p className="mono" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}

      <div className="split">
        <div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            DOCKER-COMPOSE
          </div>
          <textarea
            className="editor"
            value={compose}
            onChange={(e) => setCompose(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            PREVIEW.YML
          </div>
          <textarea
            className="editor"
            value={previewYml}
            readOnly
            placeholder="Generated preview.yml appears here"
            spellCheck={false}
          />
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="muted" style={{ fontSize: 11 }}>
          WARNINGS ({warningCount})
        </div>
        {warnings.length === 0 ? (
          <p className="muted">No warnings yet — run generate.</p>
        ) : (
          <ul className="warn-list mono">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

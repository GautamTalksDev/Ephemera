import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parsePreviewSpec, type PreviewSpec, type Service } from "../preview/index.js";

export type ComposeImportResult = {
  previewYml: string;
  spec: PreviewSpec;
  warnings: string[];
};

type ComposeService = {
  image?: string;
  build?: string | { context?: string; dockerfile?: string };
  command?: string | string[];
  entrypoint?: string | string[];
  ports?: Array<string | number | { target?: number; published?: number | string }>;
  environment?: Record<string, string> | string[];
  env_file?: string | string[];
  volumes?: unknown[];
  depends_on?: unknown;
  expose?: Array<string | number>;
};

type ComposeFile = {
  services?: Record<string, ComposeService | undefined>;
  volumes?: unknown;
  networks?: unknown;
};

function asCommand(value: string | string[] | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.join(" ");
  }
  return value.trim() || undefined;
}

function parsePublishedPort(
  port: string | number | { target?: number; published?: number | string },
): number | undefined {
  if (typeof port === "number" && Number.isFinite(port)) {
    return port;
  }
  if (typeof port === "object" && port !== null) {
    const published = port.published ?? port.target;
    if (typeof published === "number") {
      return published;
    }
    if (typeof published === "string") {
      const n = Number(published);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  }
  // "3000:3000", "127.0.0.1:3000:3000", "3000"
  const parts = String(port).split(":");
  const candidate = parts.length === 1 ? parts[0] : parts[parts.length - 2] ?? parts.at(-1);
  const n = Number(candidate);
  return Number.isFinite(n) ? n : undefined;
}

function firstPort(svc: ComposeService): number | undefined {
  for (const p of svc.ports ?? []) {
    const n = parsePublishedPort(p);
    if (n !== undefined) {
      return n;
    }
  }
  for (const p of svc.expose ?? []) {
    const n = Number(p);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

function imageName(image: string): string {
  // strip registry/tag: ghcr.io/org/postgres:16 -> postgres
  const withoutTag = image.split("@")[0]?.split(":")[0] ?? image;
  const last = withoutTag.split("/").pop() ?? withoutTag;
  return last.toLowerCase();
}

function isPostgresImage(image: string): boolean {
  const name = imageName(image);
  return name === "postgres" || name.startsWith("postgres");
}

function isNodeRuntimeImage(image: string): boolean {
  const name = imageName(image);
  return (
    name === "node" ||
    name === "bun" ||
    name === "oven/bun" ||
    name.includes("node") ||
    name.includes("bun")
  );
}

function isNginxOrStaticImage(image: string): boolean {
  const name = imageName(image);
  return name === "nginx" || name === "caddy" || name === "httpd";
}

function envFromCompose(
  environment: ComposeService["environment"],
): Record<string, string> {
  if (!environment) {
    return {};
  }
  if (Array.isArray(environment)) {
    const out: Record<string, string> = {};
    for (const item of environment) {
      const idx = item.indexOf("=");
      if (idx === -1) {
        out[item] = "";
      } else {
        out[item.slice(0, idx)] = item.slice(idx + 1);
      }
    }
    return out;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(environment)) {
    out[k] = String(v);
  }
  return out;
}

function sanitizeName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned || !/^[a-z]/.test(cleaned)) {
    return `svc-${cleaned || "x"}`.replace(/[^a-z0-9-]/g, "");
  }
  return cleaned.slice(0, 48);
}

/**
 * Draft a preview.yml from docker-compose YAML.
 * Never silently invent unsupported behavior — emit warnings instead.
 */
export function importCompose(composeYaml: string): ComposeImportResult {
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(composeYaml);
  } catch (err) {
    throw new Error(
      `invalid docker-compose YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!doc || typeof doc !== "object") {
    throw new Error("compose file must be a YAML mapping with a services: block");
  }

  const compose = doc as ComposeFile;
  if (!compose.services || typeof compose.services !== "object") {
    throw new Error("compose file is missing services:");
  }

  if (compose.volumes) {
    warnings.push(
      "top-level volumes: are not mapped — Ephemera environments are ephemeral and do not persist named volumes",
    );
  }
  if (compose.networks) {
    warnings.push("top-level networks: are ignored (Ephemera provides its own networking)");
  }

  type Draft = {
    name: string;
    composeName: string;
    service: Service;
    port?: number | undefined;
  };

  const drafts: Draft[] = [];

  for (const [rawName, rawSvc] of Object.entries(compose.services)) {
    if (!rawSvc || typeof rawSvc !== "object") {
      warnings.push(`service "${rawName}": empty definition skipped`);
      continue;
    }
    const name = sanitizeName(rawName);
    const image = rawSvc.image ?? "";
    const port = firstPort(rawSvc);
    const env = envFromCompose(rawSvc.environment);

    if (rawSvc.volumes && Array.isArray(rawSvc.volumes) && rawSvc.volumes.length > 0) {
      warnings.push(
        `service "${rawName}": volumes are not mapped (${rawSvc.volumes.length} mount(s) dropped)`,
      );
    }
    if (rawSvc.depends_on) {
      warnings.push(
        `service "${rawName}": depends_on ordering is not preserved — start order is best-effort`,
      );
    }
    if (rawSvc.env_file) {
      warnings.push(
        `service "${rawName}": env_file is not read; inline environment: keys only were imported`,
      );
    }

    if (image && isPostgresImage(image)) {
      drafts.push({
        name,
        composeName: rawName,
        port,
        service: {
          name,
          type: "database",
          engine: "postgresql@16",
          public: false,
          env,
        },
      });
      if (!image.includes("16") && !image.includes("postgres:16")) {
        warnings.push(
          `service "${rawName}": image "${image}" mapped to postgresql@16 (only engine currently supported)`,
        );
      }
      continue;
    }

    if (image && isNginxOrStaticImage(image)) {
      drafts.push({
        name,
        composeName: rawName,
        port: port ?? 80,
        service: {
          name,
          type: "static",
          build: {
            commands: ["echo 'static assets expected in build context'", "true"],
          },
          port: port ?? 80,
          public: false,
          env,
        },
      });
      warnings.push(
        `service "${rawName}": image "${image}" drafted as type=static with placeholder build commands — replace with your real static build`,
      );
      continue;
    }

    if (image && isNodeRuntimeImage(image)) {
      const start =
        asCommand(rawSvc.command) ??
        asCommand(rawSvc.entrypoint) ??
        "npm start";
      const buildCommands = ["npm ci"];
      if (rawSvc.build) {
        buildCommands.push("npm run build");
      } else {
        warnings.push(
          `service "${rawName}": no build: section — drafted build.commands as ["npm ci"] only; add a build step if needed`,
        );
      }
      drafts.push({
        name,
        composeName: rawName,
        port: port ?? 3000,
        service: {
          name,
          type: "runtime",
          runtime: "nodejs@22",
          build: { commands: buildCommands },
          start,
          port: port ?? 3000,
          public: false,
          env,
        },
      });
      if (!port) {
        warnings.push(
          `service "${rawName}": no ports: found — defaulted runtime port to 3000`,
        );
      }
      continue;
    }

    if (!image && rawSvc.build) {
      // build-only service without image — assume node runtime
      const start = asCommand(rawSvc.command) ?? "npm start";
      drafts.push({
        name,
        composeName: rawName,
        port: port ?? 3000,
        service: {
          name,
          type: "runtime",
          runtime: "nodejs@22",
          build: { commands: ["npm ci", "npm run build"] },
          start,
          port: port ?? 3000,
          public: false,
          env,
        },
      });
      warnings.push(
        `service "${rawName}": no image: — assumed nodejs@22 runtime from build: context`,
      );
      continue;
    }

    warnings.push(
      `service "${rawName}": could not map image "${image || "(none)"}" — skipped (unknown image family)`,
    );
  }

  if (drafts.length === 0) {
    throw new Error("no mappable services found in compose file");
  }

  // Pick public service: named web/frontend/app, else lowest exposed port among non-db.
  const namedPublic = drafts.find((d) =>
    /^(web|frontend|app|ui|client)$/i.test(d.composeName),
  );
  const nonDb = drafts.filter((d) => d.service.type !== "database");
  let publicDraft = namedPublic;
  if (!publicDraft && nonDb.length > 0) {
    publicDraft = [...nonDb].sort(
      (a, b) => (a.port ?? 99999) - (b.port ?? 99999),
    )[0];
  }
  if (!publicDraft) {
    publicDraft = drafts[0];
    warnings.push(
      "no obvious public service — marked the first drafted service as public: true",
    );
  }

  for (const d of drafts) {
    d.service = {
      ...d.service,
      public: d === publicDraft,
    };
  }

  if (drafts.length > 6) {
    warnings.push(
      `compose has ${drafts.length} drafted services; Ephemera allows at most 6 — truncating`,
    );
    drafts.splice(6);
    // ensure one public remains
    if (!drafts.some((d) => d.service.public)) {
      const first = drafts[0];
      if (first) {
        first.service = { ...first.service, public: true };
      }
    }
  }

  const spec: PreviewSpec = {
    version: 1,
    services: drafts.map((d) => d.service),
    ttlMinutes: 60,
  };

  const previewYml = stringifyYaml(spec, {
    indent: 2,
    lineWidth: 0,
  }).trimEnd() + "\n";

  const validated = parsePreviewSpec(previewYml);
  if (!validated.ok) {
    throw new Error(
      `drafted preview.yml failed validation: ${validated.errors.join("; ")}`,
    );
  }

  return {
    previewYml,
    spec: validated.spec,
    warnings,
  };
}

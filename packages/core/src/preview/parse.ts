import { LineCounter, parseDocument } from "yaml";
import {
  PreviewSpecSchema,
  defaultTtlMinutes,
  type ParsePreviewSpecResult,
  type PreviewSpec,
} from "./schema.js";
import { validateSpec } from "./validate.js";
import { formatError, lineForPath } from "./yaml-path.js";

function issueMessage(issue: {
  message: string;
  code?: string;
  path: PropertyKey[];
}): string {
  // Prefer zod's message; normalize a few common cases for readability.
  if (issue.message.length > 0) {
    return issue.message;
  }
  return "invalid value";
}

export function parsePreviewSpec(yamlString: string): ParsePreviewSpecResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(yamlString, {
    lineCounter,
    prettyErrors: true,
  });

  if (doc.errors.length > 0) {
    return {
      ok: false,
      errors: doc.errors.map((err) => {
        const line = err.linePos?.[0]?.line;
        if (line !== undefined) {
          return `(root): ${err.message} (line ${line})`;
        }
        return `(root): ${err.message}`;
      }),
    };
  }

  const raw: unknown = doc.toJS({ maxAliasCount: 100 });
  const parsed = PreviewSpecSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => {
        const path = issue.path as PropertyKey[];
        const line = lineForPath(doc, lineCounter, path);
        return formatError(issueMessage(issue), path, line);
      }),
    };
  }

  const semantic = validateSpec(parsed.data);
  if (!semantic.ok) {
    return {
      ok: false,
      errors: semantic.errors.map((err) => {
        const line = lineForPath(doc, lineCounter, err.path);
        return formatError(err.message, err.path, line);
      }),
    };
  }

  const spec: PreviewSpec = {
    ...parsed.data,
    ttlMinutes: parsed.data.ttlMinutes ?? defaultTtlMinutes(),
  };

  return { ok: true, spec };
}

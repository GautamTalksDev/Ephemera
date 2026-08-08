import {
  isMap,
  isSeq,
  isScalar,
  type Document,
  type LineCounter,
  type Node,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

export function formatYamlPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (typeof segment === "symbol") {
      out += out ? `.${String(segment)}` : String(segment);
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      out += out ? `.${segment}` : segment;
    } else {
      out += `[${JSON.stringify(segment)}]`;
    }
  }
  return out || "(root)";
}

function asNode(value: unknown): Node | null {
  if (value && typeof value === "object" && "range" in (value as object)) {
    return value as Node;
  }
  return null;
}

export function locateYamlNode(
  doc: Document,
  path: ReadonlyArray<PropertyKey>,
): Node | null {
  let current: unknown = doc.contents;
  for (const segment of path) {
    if (current == null) {
      return null;
    }
    if (isMap(current) && (typeof segment === "string" || typeof segment === "number")) {
      const map = current as YAMLMap;
      const key = String(segment);
      const pair = map.items.find(
        (item) => isScalar(item.key) && String(item.key.value) === key,
      );
      if (!pair) {
        return asNode(current);
      }
      // Prefer the value node; fall back to the key for missing values.
      current = pair.value ?? pair.key;
      continue;
    }
    if (isSeq(current) && typeof segment === "number") {
      const seq = current as YAMLSeq;
      current = seq.items[segment];
      continue;
    }
    return asNode(current);
  }
  return asNode(current);
}

export function lineForPath(
  doc: Document,
  lineCounter: LineCounter,
  path: ReadonlyArray<PropertyKey>,
): number | undefined {
  const node = locateYamlNode(doc, path);
  const offset = node?.range?.[0];
  if (offset === undefined) {
    return undefined;
  }
  return lineCounter.linePos(offset).line;
}

export function formatError(
  message: string,
  path: ReadonlyArray<PropertyKey>,
  line?: number,
): string {
  const yamlPath = formatYamlPath(path);
  if (line !== undefined) {
    return `${yamlPath}: ${message} (line ${line})`;
  }
  return `${yamlPath}: ${message}`;
}

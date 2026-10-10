/**
 * OpenAI function-calling schemas → Gemini Live `functionDeclarations`.
 *
 * The two formats look similar enough to be dangerous. Gemini accepts a *subset
 * of OpenAPI 3.0 Schema*, not full JSON Schema, and it rejects the whole setup
 * message when it meets a field it does not know — so an unrecognised
 * `additionalProperties` does not get ignored, it closes the socket. That is why
 * this is a whitelist-based rewrite rather than a shallow reshape.
 *
 * Differences that actually bite:
 *   - `type` is an enum (STRING / NUMBER / INTEGER / BOOLEAN / ARRAY / OBJECT),
 *     so it is upper-cased rather than passed through as JSON Schema's lowercase.
 *   - `additionalProperties` and `default` are not part of the subset and are
 *     dropped. Dropping `default` is safe: defaults are applied by our own
 *     executors in `ai.ts`, never by the model.
 *   - a no-argument tool must omit `parameters` entirely. Sending
 *     `{ type: OBJECT, properties: {} }` is rejected as an empty object schema,
 *     which is exactly what `get_situation` would produce if passed through.
 *
 * Deliberately zero runtime imports so this is unit-testable under `node --test`
 * (a test can only import modules whose whole graph avoids extensionless imports
 * — esbuild resolves those for the prod bundle, but type-stripping does not).
 */

export interface OpenAiTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface GeminiSchema {
  type?: string;
  description?: string;
  enum?: string[];
  format?: string;
  nullable?: boolean;
  items?: GeminiSchema;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: GeminiSchema;
}

const TYPE_MAP: Record<string, string> = {
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  array: "ARRAY",
  object: "OBJECT",
};

// `format` is only meaningful for a few values; anything else is rejected, so
// only these survive. None of the current tools use it, but a future one might.
const ALLOWED_FORMATS = new Set([
  "float",
  "double",
  "int32",
  "int64",
  "enum",
  "date-time",
]);

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((v): v is string => typeof v === "string");
  return strings.length > 0 ? strings : undefined;
}

/**
 * Rewrites one schema node into the Gemini subset. Unknown keys are dropped
 * rather than forwarded — see the file header for why that matters.
 */
export function convertSchema(node: unknown): GeminiSchema {
  if (typeof node !== "object" || node === null) return {};
  const src = node as Record<string, unknown>;
  const out: GeminiSchema = {};

  if (typeof src.type === "string") {
    const mapped = TYPE_MAP[src.type.toLowerCase()];
    if (mapped) out.type = mapped;
  }
  if (typeof src.description === "string") out.description = src.description;
  if (typeof src.nullable === "boolean") out.nullable = src.nullable;

  const enumValues = asStringArray(src.enum);
  if (enumValues) out.enum = enumValues;

  if (typeof src.format === "string" && ALLOWED_FORMATS.has(src.format)) {
    out.format = src.format;
  }

  const minimum = asNumber(src.minimum);
  if (minimum !== undefined) out.minimum = minimum;
  const maximum = asNumber(src.maximum);
  if (maximum !== undefined) out.maximum = maximum;
  const minItems = asNumber(src.minItems);
  if (minItems !== undefined) out.minItems = minItems;
  const maxItems = asNumber(src.maxItems);
  if (maxItems !== undefined) out.maxItems = maxItems;

  if (src.items !== undefined) {
    out.items = convertSchema(src.items);
  }

  if (typeof src.properties === "object" && src.properties !== null) {
    const props: Record<string, GeminiSchema> = {};
    for (const [key, value] of Object.entries(src.properties as Record<string, unknown>)) {
      props[key] = convertSchema(value);
    }
    // An OBJECT with no properties is an empty schema Gemini rejects; leave
    // `properties` off entirely so the caller can decide to drop the parameter.
    if (Object.keys(props).length > 0) out.properties = props;
  }

  const required = asStringArray(src.required);
  if (required) out.required = required;

  return out;
}

/** True when a converted schema carries no usable information. */
function isEmptyObjectSchema(schema: GeminiSchema): boolean {
  return schema.type === "OBJECT" && schema.properties === undefined;
}

/**
 * Converts a whole OpenAI tool list. A tool taking no arguments comes back with
 * `parameters` omitted, which is what the Live API requires.
 */
export function toGeminiFunctionDeclarations(
  tools: readonly OpenAiTool[],
): GeminiFunctionDeclaration[] {
  return tools.map((tool) => {
    const parameters = convertSchema(tool.function.parameters);
    const declaration: GeminiFunctionDeclaration = {
      name: tool.function.name,
      description: tool.function.description,
    };
    if (!isEmptyObjectSchema(parameters)) {
      declaration.parameters = parameters;
    }
    return declaration;
  });
}

/**
 * Keywords that make the Live API reject the entire setup message. The converter
 * strips these, so finding one downstream means a schema shape slipped past it.
 */
const BANNED_KEYWORDS = [
  "additionalProperties",
  "default",
  "$schema",
  "$ref",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "oneOf",
  "anyOf",
  "allOf",
  "patternProperties",
];

/**
 * Fails loudly if converted declarations still contain anything the Live API
 * rejects, or a type that was not mapped to its enum.
 *
 * This is a guard against *future* tools, not today's. The converter whitelists,
 * so it cannot leak a keyword it knows about — but a tool added later with a
 * shape nobody anticipated (a `oneOf` union, say) would otherwise fail at
 * runtime as an opaque upstream socket close. Better to throw at startup with
 * the offending tool named.
 */
export function assertGeminiSafe(declarations: readonly GeminiFunctionDeclaration[]): void {
  const problems: string[] = [];

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (typeof node !== "object" || node === null) return;

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (BANNED_KEYWORDS.includes(key)) {
        problems.push(`${path}.${key} is not supported by the Live API`);
      }
      if (key === "type" && typeof value === "string" && value !== value.toUpperCase()) {
        problems.push(`${path}.type "${value}" was not mapped to the Gemini type enum`);
      }
      walk(value, `${path}.${key}`);
    }
  };

  for (const declaration of declarations) {
    if (!declaration.name) problems.push("a function declaration has no name");
    walk(declaration, declaration.name || "<unnamed>");
  }

  if (problems.length > 0) {
    throw new Error(
      `Tool schemas are not Live API compatible:\n  ${problems.join("\n  ")}`,
    );
  }
}

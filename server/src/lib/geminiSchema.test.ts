import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  convertSchema,
  toGeminiFunctionDeclarations,
  assertGeminiSafe,
  type OpenAiTool,
} from "./geminiSchema.ts";

/**
 * Fixtures mirror the shapes actually present in `aiTools.ts`: a no-arg tool, a
 * bounded number, an enum string, an array-of-enum, and the nested
 * triggers/actions objects from `create_rule`. If a real tool grows a shape not
 * represented here, add it here too — the whole point is that a schema Gemini
 * would reject never reaches the socket.
 */

const NO_ARGS: OpenAiTool = {
  type: "function",
  function: {
    name: "get_situation",
    description: "Current farm situation.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

const BOUNDED_NUMBER: OpenAiTool = {
  type: "function",
  function: {
    name: "get_readings_history",
    description: "History stats.",
    parameters: {
      type: "object",
      properties: {
        hours: { type: "number", description: "Hours back", minimum: 1, maximum: 168 },
      },
      additionalProperties: false,
    },
  },
};

const NESTED: OpenAiTool = {
  type: "function",
  function: {
    name: "create_rule",
    description: "Create a rule.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Rule name" },
        enabled: { type: "boolean", default: true },
        priority: { type: "number", default: 100 },
        triggerMode: { type: "string", enum: ["all", "any"], default: "all" },
        triggers: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              sensor: { type: "string", enum: ["air_temp", "co2"] },
              operator: { type: "string", enum: [">", "<"] },
              value: { type: "number" },
            },
            required: ["sensor", "operator", "value"],
          },
        },
        actions: {
          type: "object",
          properties: {
            turnOn: { type: "array", items: { type: "string", enum: ["fan", "ac"] } },
          },
          default: { turnOn: [] },
        },
      },
      required: ["name", "triggers"],
      additionalProperties: false,
    },
  },
};

describe("convertSchema — type mapping", () => {
  it("upper-cases JSON Schema types into Gemini's enum", () => {
    assert.equal(convertSchema({ type: "string" }).type, "STRING");
    assert.equal(convertSchema({ type: "number" }).type, "NUMBER");
    assert.equal(convertSchema({ type: "integer" }).type, "INTEGER");
    assert.equal(convertSchema({ type: "boolean" }).type, "BOOLEAN");
    assert.equal(convertSchema({ type: "array" }).type, "ARRAY");
    assert.equal(convertSchema({ type: "object" }).type, "OBJECT");
  });

  it("omits an unrecognised type rather than forwarding it", () => {
    assert.equal(convertSchema({ type: "null" }).type, undefined);
    assert.equal(convertSchema({ type: "anyOf" }).type, undefined);
  });

  it("survives a non-object node without throwing", () => {
    assert.deepEqual(convertSchema(null), {});
    assert.deepEqual(convertSchema("string"), {});
    assert.deepEqual(convertSchema(undefined), {});
  });
});

describe("convertSchema — dropping what Gemini rejects", () => {
  it("drops additionalProperties, which would close the socket", () => {
    const out = convertSchema({ type: "object", additionalProperties: false });
    assert.equal("additionalProperties" in out, false);
  });

  it("drops default — our executors apply defaults, never the model", () => {
    const out = convertSchema({ type: "boolean", default: true });
    assert.equal("default" in out, false);
  });

  it("drops unknown keywords entirely", () => {
    const out = convertSchema({
      type: "string",
      $schema: "http://json-schema.org/draft-07/schema#",
      exclusiveMinimum: 3,
      pattern: "^a",
      examples: ["a"],
    });
    assert.deepEqual(out, { type: "STRING" });
  });

  it("keeps only formats inside the supported set", () => {
    assert.equal(convertSchema({ type: "number", format: "float" }).format, "float");
    assert.equal(convertSchema({ type: "string", format: "uuid" }).format, undefined);
  });
});

describe("convertSchema — preserved constraints", () => {
  it("keeps description, enum, required and numeric bounds", () => {
    const out = convertSchema({
      type: "object",
      description: "d",
      properties: {
        mode: { type: "string", enum: ["auto", "manual"] },
        hours: { type: "number", minimum: 1, maximum: 168 },
      },
      required: ["mode"],
    });
    assert.equal(out.description, "d");
    assert.deepEqual(out.properties?.mode.enum, ["auto", "manual"]);
    assert.equal(out.properties?.hours.minimum, 1);
    assert.equal(out.properties?.hours.maximum, 168);
    assert.deepEqual(out.required, ["mode"]);
  });

  it("keeps array bounds and recurses into items", () => {
    const out = convertSchema({
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: { type: "string", enum: ["fan", "ac"] },
    });
    assert.equal(out.minItems, 1);
    assert.equal(out.maxItems, 4);
    assert.equal(out.items?.type, "STRING");
    assert.deepEqual(out.items?.enum, ["fan", "ac"]);
  });

  it("recurses through nested objects inside array items", () => {
    const out = convertSchema(NESTED.function.parameters);
    const trigger = out.properties?.triggers.items;
    assert.equal(trigger?.type, "OBJECT");
    assert.equal(trigger?.properties?.sensor.type, "STRING");
    assert.deepEqual(trigger?.properties?.operator.enum, [">", "<"]);
    assert.deepEqual(trigger?.required, ["sensor", "operator", "value"]);
  });

  it("drops a non-string enum instead of emitting a mixed array", () => {
    assert.equal(convertSchema({ type: "number", enum: [1, 2, 3] }).enum, undefined);
  });
});

describe("toGeminiFunctionDeclarations", () => {
  it("omits parameters for a no-argument tool", () => {
    const [decl] = toGeminiFunctionDeclarations([NO_ARGS]);
    assert.equal(decl.name, "get_situation");
    assert.equal(decl.description, "Current farm situation.");
    // An OBJECT with empty properties is rejected as an empty schema.
    assert.equal("parameters" in decl, false);
  });

  it("keeps parameters for a tool that takes arguments", () => {
    const [decl] = toGeminiFunctionDeclarations([BOUNDED_NUMBER]);
    assert.equal(decl.parameters?.type, "OBJECT");
    assert.equal(decl.parameters?.properties?.hours.maximum, 168);
  });

  it("carries name and description through untouched", () => {
    const decls = toGeminiFunctionDeclarations([NO_ARGS, BOUNDED_NUMBER, NESTED]);
    assert.deepEqual(
      decls.map((d) => d.name),
      ["get_situation", "get_readings_history", "create_rule"],
    );
    assert.equal(decls.every((d) => d.description.length > 0), true);
  });

  it("produces no rejected keyword anywhere in the output tree", () => {
    const decls = toGeminiFunctionDeclarations([NO_ARGS, BOUNDED_NUMBER, NESTED]);
    const serialised = JSON.stringify(decls);
    for (const banned of ["additionalProperties", "default", "$schema", "exclusiveMinimum"]) {
      assert.equal(
        serialised.includes(banned),
        false,
        `${banned} leaked into the Live API setup payload`,
      );
    }
  });

  it("emits only lower-case-free types, so nothing is passed through raw", () => {
    const decls = toGeminiFunctionDeclarations([NESTED]);
    const types: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;
      if (typeof record.type === "string") types.push(record.type);
      for (const value of Object.values(record)) walk(value);
    };
    walk(decls);
    assert.equal(types.length > 0, true);
    assert.deepEqual(
      types.filter((t) => t !== t.toUpperCase()),
      [],
    );
  });

  it("handles an empty tool list", () => {
    assert.deepEqual(toGeminiFunctionDeclarations([]), []);
  });
});

describe("assertGeminiSafe", () => {
  it("accepts everything the converter produces", () => {
    const decls = toGeminiFunctionDeclarations([NO_ARGS, BOUNDED_NUMBER, NESTED]);
    assert.doesNotThrow(() => assertGeminiSafe(decls));
  });

  it("accepts an empty list", () => {
    assert.doesNotThrow(() => assertGeminiSafe([]));
  });

  it("catches a banned keyword that bypassed the converter", () => {
    // Simulates a future tool hand-written straight into declaration shape.
    const smuggled = [
      {
        name: "bad_tool",
        description: "d",
        parameters: {
          type: "OBJECT",
          properties: { a: { type: "STRING" } },
          additionalProperties: false,
        },
      },
    ] as never;
    assert.throws(() => assertGeminiSafe(smuggled), /additionalProperties/);
  });

  it("names the offending tool so the error is actionable", () => {
    const smuggled = [
      { name: "create_rule", description: "d", parameters: { type: "OBJECT", default: {} } },
    ] as never;
    assert.throws(() => assertGeminiSafe(smuggled), /create_rule/);
  });

  it("catches a lower-case type that was never mapped", () => {
    const smuggled = [
      {
        name: "bad_type",
        description: "d",
        parameters: { type: "OBJECT", properties: { a: { type: "string" } } },
      },
    ] as never;
    assert.throws(() => assertGeminiSafe(smuggled), /not mapped/);
  });

  it("catches a union keyword nested deep inside an array item", () => {
    const smuggled = [
      {
        name: "deep",
        description: "d",
        parameters: {
          type: "OBJECT",
          properties: {
            list: { type: "ARRAY", items: { type: "OBJECT", oneOf: [{ type: "STRING" }] } },
          },
        },
      },
    ] as never;
    assert.throws(() => assertGeminiSafe(smuggled), /oneOf/);
  });

  it("rejects a declaration with no name", () => {
    assert.throws(() => assertGeminiSafe([{ name: "", description: "d" }] as never), /no name/);
  });

  it("reports every problem at once, not just the first", () => {
    const smuggled = [
      { name: "a", description: "d", parameters: { type: "OBJECT", default: 1 } },
      { name: "b", description: "d", parameters: { type: "OBJECT", $ref: "#/x" } },
    ] as never;
    assert.throws(() => assertGeminiSafe(smuggled), (err: Error) => {
      assert.match(err.message, /default/);
      assert.match(err.message, /\$ref/);
      return true;
    });
  });
});

import { z } from "zod";
import { SENSOR_KEYS, RULE_OPERATORS, MATCH_MODES } from "../models/automationRule";

/**
 * Runtime validation for the AutomationRule API. These mirror the model
 * constraints so a malformed rule can never reach Mongo — the ESP-side parser
 * skips invalid rules silently, so we validate aggressively on the server.
 */

export const ConditionSchema = z.object({
  sensor: z.enum(SENSOR_KEYS),
  operator: z.enum(RULE_OPERATORS),
  value: z.number().finite(),
});

export const RelayKeysSchema = z.array(z.string().min(1).max(32));

export const RuleInputSchema = z.object({
  name: z.string().trim().min(1, "Rule name is required").max(120),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0, "Priority must be 0-1000").max(1000).default(100),
  profileIds: z.array(z.string()).default([]),
  stageKeys: z.array(z.string().min(1).max(40)).default([]),
  triggerMode: z.enum(MATCH_MODES).default("all"),
  triggers: z
    .array(ConditionSchema)
    .min(1, "IF block needs at least 1 trigger condition (e.g. Temp < 30)")
    .max(8),
  actions: z
    .object({
      turnOn: RelayKeysSchema.default([]),
      turnOff: RelayKeysSchema.default([]),
    })
    .default({ turnOn: [], turnOff: [] }),
  cutoffMode: z.enum(MATCH_MODES).default("any"),
  cutoffs: z
    .array(ConditionSchema)
    .min(1, "STOP block needs at least 1 cutoff condition (e.g. Temp >= 25)")
    .max(8),
  offActions: z
    .object({
      turnOff: RelayKeysSchema.default([]),
    })
    .default({ turnOff: [] }),
  minOnMs: z.number().int().min(0).max(86_400_000).default(0),
  minOffMs: z.number().int().min(0).max(86_400_000).default(0),
  cooldownMs: z.number().int().min(0).max(86_400_000).default(0),
});

export type RuleInput = z.infer<typeof RuleInputSchema>;

export const RuleUpdateSchema = RuleInputSchema.partial();

export type RuleUpdate = z.infer<typeof RuleUpdateSchema>;

/**
 * Converts a validation failure into a short, human-readable message so the
 * dashboard never has to show raw Zod issue arrays.
 */
export function formatRuleError(err: unknown): string {
  if (err instanceof z.ZodError) {
    const parts = err.issues.map((issue) => {
      const path = issue.path.join(".");
      const where = path ? `${path}: ` : "";
      return `${where}${issue.message}`;
    });
    return parts.join(" · ");
  }
  return err instanceof Error ? err.message : "Invalid rule";
}

export function assertRuleSane(rule: RuleInput): void {
  const hasOnAction = rule.actions.turnOn.length > 0 || rule.actions.turnOff.length > 0;
  if (!hasOnAction) {
    throw new RangeError("THEN block must turn at least one relay ON or OFF");
  }
  if (rule.offActions.turnOff.length === 0) {
    throw new RangeError("STOP block must release at least one relay (pick a device under Release)");
  }
  if (rule.minOnMs > 0 && rule.minOffMs > 0) {
    // very conservative sanity check — dwell timers should not swallow each other
    if (rule.minOffMs > rule.minOnMs) {
      throw new RangeError("minOffMs cannot exceed minOnMs");
    }
  }
}
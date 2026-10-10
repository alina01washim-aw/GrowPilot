import { customFetch } from "./custom-fetch";

export const RULE_SENSORS = [
  { key: "air_temp", label: "Temp (SHT40)", unit: "°C" },
  { key: "humidity", label: "Humidity (SHT40)", unit: "%" },
  { key: "co2", label: "CO₂ (SCD40)", unit: "ppm" },
  { key: "scd_temp", label: "SCD40 Temp", unit: "°C" },
  { key: "scd_hum", label: "SCD40 Hum", unit: "%" },
  { key: "compost_temp", label: "Compost Temp", unit: "°C" },
] as const;

export const RULE_OPERATORS = [">", ">=", "<", "<=", "==", "!="] as const;

/**
 * Devices a rule can act on, in display order. Keys only — names come from the
 * device registry so a renamed device reads correctly in the rule builder.
 */
export const RULE_RELAY_KEYS = ["fan", "ac", "mist_maker", "uv"] as const;

/**
 * Crop stages a rule can be scoped to. A rule with no stages is unscoped and
 * always applies; a scoped rule is only pushed to the device while one of its
 * stages is running.
 */
export const RULE_STAGES = [
  { key: "spawn_run", label: "Spawn Run" },
  { key: "case_run", label: "Case Run" },
  { key: "pinning", label: "Pinning" },
  { key: "fruiting", label: "Fruiting" },
  { key: "flush_break", label: "Flush Break" },
] as const;

export interface RuleCondition {
  sensor: string;
  operator: string;
  value: number;
}

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  profileIds: string[];
  /** Empty = active in every stage. */
  stageKeys: string[];
  triggerMode: "all" | "any";
  triggers: RuleCondition[];
  actions: { turnOn: string[]; turnOff: string[] };
  cutoffMode: "all" | "any";
  cutoffs: RuleCondition[];
  offActions: { turnOff: string[] };
  minOnMs: number;
  minOffMs: number;
  cooldownMs: number;
  createdAt: string;
  updatedAt: string;
}

export type RuleInput = Omit<
  AutomationRule,
  "id" | "createdAt" | "updatedAt"
>;

export type RuleDraft = RuleInput & { id?: string };

export function getRuleList(): Promise<AutomationRule[]> {
  return customFetch<AutomationRule[]>("/api/rules");
}

export function createRule(input: RuleInput): Promise<AutomationRule> {
  return customFetch<AutomationRule>("/api/rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function updateRule(id: string, input: Partial<RuleInput>): Promise<AutomationRule> {
  return customFetch<AutomationRule>(`/api/rules/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function deleteRule(id: string): Promise<void> {
  return customFetch<void>(`/api/rules/${id}`, { method: "DELETE" });
}

export function emptyRuleDraft(): RuleDraft {
  return {
    name: "",
    enabled: true,
    priority: 100,
    profileIds: [],
    stageKeys: [],
    triggerMode: "all",
    triggers: [{ sensor: "air_temp", operator: "<", value: 30 }],
    actions: { turnOn: [], turnOff: [] },
    cutoffMode: "any",
    cutoffs: [{ sensor: "air_temp", operator: ">=", value: 25 }],
    offActions: { turnOff: [] },
    minOnMs: 60_000,
    minOffMs: 0,
    cooldownMs: 5_000,
  };
}
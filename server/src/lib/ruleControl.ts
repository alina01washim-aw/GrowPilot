import { AutomationRuleModel, type AutomationRuleDocument } from "../models/automationRule";
import { DeviceProfileModel, DEFAULT_RELAY_MAP } from "../models/deviceProfile";
import { RelayModel } from "../models/relay";
import { SettingsModel } from "../models/settings";
import {
  RuleInputSchema,
  RuleUpdateSchema,
  assertRuleSane,
  type RuleInput,
  type RuleUpdate,
} from "./ruleSchemas";
import { getMqttClient } from "./mqttClientRef";
import { getActiveStageKey, ruleAppliesToStage } from "./activeStage";
import { clearRuleLatch } from "./ruleEvaluator";
import { logger } from "./logger";

// Topic the established single-device deployment uses. Multi-profile deploys
// publish per device: fridge/<profileId>/rules.
const DEFAULT_PROFILE_ID = "main";
const RULES_TOPIC = "fridge/rules";

export interface RuleView {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  profileIds: string[];
  stageKeys: string[];
  triggerMode: "all" | "any";
  triggers: Array<{ sensor: string; operator: string; value: number }>;
  actions: { turnOn: string[]; turnOff: string[] };
  cutoffMode: "all" | "any";
  cutoffs: Array<{ sensor: string; operator: string; value: number }>;
  offActions: { turnOff: string[] };
  minOnMs: number;
  minOffMs: number;
  cooldownMs: number;
  createdAt: string;
  updatedAt: string;
}

function toView(doc: AutomationRuleDocument & { id: string }): RuleView {
  return {
    id: doc.id,
    name: doc.name,
    enabled: doc.enabled,
    priority: doc.priority,
    profileIds: doc.profileIds ?? [],
    stageKeys: doc.stageKeys ?? [],
    triggerMode: doc.triggerMode as "all" | "any",
    triggers: doc.triggers.map((t) => ({
      sensor: t.sensor,
      operator: t.operator,
      value: t.value,
    })),
    actions: {
      turnOn: doc.actions?.turnOn ?? [],
      turnOff: doc.actions?.turnOff ?? [],
    },
    cutoffMode: doc.cutoffMode as "all" | "any",
    cutoffs: doc.cutoffs.map((t) => ({
      sensor: t.sensor,
      operator: t.operator,
      value: t.value,
    })),
    offActions: { turnOff: doc.offActions?.turnOff ?? [] },
    minOnMs: doc.minOnMs ?? 0,
    minOffMs: doc.minOffMs ?? 0,
    cooldownMs: doc.cooldownMs ?? 0,
    createdAt: doc.createdAt?.toISOString() ?? new Date().toISOString(),
    updatedAt: doc.updatedAt?.toISOString() ?? new Date().toISOString(),
  };
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function listRules(): Promise<RuleView[]> {
  const docs = await AutomationRuleModel.find().sort({ priority: 1, createdAt: 1 }).lean();
  return docs.map((d) => toView({ ...d, id: (d._id as { toString(): string }).toString() }));
}

export async function getRule(id: string): Promise<RuleView | null> {
  const doc = await AutomationRuleModel.findById(id).lean();
  if (!doc) return null;
  return toView({ ...doc, id: (doc._id as { toString(): string }).toString() });
}

export async function createRule(input: RuleInput): Promise<RuleView> {
  const parsed = RuleInputSchema.parse(input);
  assertRuleSane(parsed);

  const doc = await AutomationRuleModel.create(parsed);
  const view = toView({ ...(doc.toObject() as AutomationRuleDocument), id: doc.id });

  await publishAffectedProfiles(parsed.profileIds ?? []);
  return view;
}

export async function updateRule(id: string, patch: RuleUpdate): Promise<RuleView> {
  const existing = await AutomationRuleModel.findById(id).lean();
  if (!existing) throw new Error("rule-not-found");

  const parsedPatch = RuleUpdateSchema.parse(patch);
  const merged: RuleInput = {
    name: existing.name,
    enabled: existing.enabled,
    priority: existing.priority,
    profileIds: existing.profileIds ?? [],
    stageKeys: existing.stageKeys ?? [],
    triggerMode: existing.triggerMode as "all" | "any",
    triggers: existing.triggers.map((t) => ({
      sensor: t.sensor as never,
      operator: t.operator as never,
      value: t.value,
    })),
    actions: {
      turnOn: existing.actions?.turnOn ?? [],
      turnOff: existing.actions?.turnOff ?? [],
    },
    cutoffMode: existing.cutoffMode as "all" | "any",
    cutoffs: existing.cutoffs.map((t) => ({
      sensor: t.sensor as never,
      operator: t.operator as never,
      value: t.value,
    })),
    offActions: { turnOff: existing.offActions?.turnOff ?? [] },
    minOnMs: existing.minOnMs ?? 0,
    minOffMs: existing.minOffMs ?? 0,
    cooldownMs: existing.cooldownMs ?? 0,
    ...parsedPatch,
  };

  try {
    assertRuleSane(merged);
  } catch (err) {
    if (err instanceof RangeError) throw err;
  }

  const doc = await AutomationRuleModel.findByIdAndUpdate(
    id,
    {
      $set: { ...parsedPatch, updatedAt: new Date() },
    },
    { new: true },
  ).lean();
  if (!doc) throw new Error("rule-not-found");

  const view = toView({ ...doc, id: (doc._id as { toString(): string }).toString() });

  // A rule's latch is runtime state over its *previous* definition. Editing the
  // thresholds, disabling it, or changing which devices it drives all invalidate
  // that state — keeping it would leave the rule latched against conditions it no
  // longer has, and hold a stale dwell window. Re-latching costs one pass.
  await clearRuleLatch(view.id);

  await publishAffectedProfiles(merged.profileIds);
  return view;
}

export async function deleteRule(id: string): Promise<void> {
  const doc = await AutomationRuleModel.findByIdAndDelete(id).lean();
  if (!doc) throw new Error("rule-not-found");
  await clearRuleLatch(id);
  await publishAffectedProfiles(doc.profileIds ?? []);
}

// ─── Device profiles ─────────────────────────────────────────────────────────

export async function ensureMainProfile(): Promise<void> {
  await DeviceProfileModel.updateOne(
    { profileId: DEFAULT_PROFILE_ID },
    {
      $setOnInsert: {
        profileId: DEFAULT_PROFILE_ID,
        name: "Main Controller",
        description: "Primary ESP32 (legacy single-device deployment)",
        relayMap: DEFAULT_RELAY_MAP,
      },
    },
    { upsert: true },
  );
}

// Rule key → legacy Relay document name. The legacy doc's automationEnabled
// flag is the authoritative AUTO/MANUAL switch for mapped devices; devices
// without one (uv) keep their mode in the profile relayMap.
const LEGACY_RELAY_NAME: Record<string, string | null> = {
  fan: "fan",
  ac: "fridge",
  mist_maker: "humidifier",
  uv: null,
};

async function getRelayMap(
  profileId: string,
): Promise<Array<{ key: string; index: number; enabled: boolean }>> {
  const profile =
    profileId !== DEFAULT_PROFILE_ID
      ? await DeviceProfileModel.findOne({ profileId }).lean()
      : null;

  const mapEntries =
    profile?.relayMap?.length && profileId !== DEFAULT_PROFILE_ID
      ? profile.relayMap
      : DEFAULT_RELAY_MAP;

  // For the default single-device deployment, the Relay documents are the
  // source of truth for AUTO/MANUAL mode of the mapped devices.
  const relayDocs =
    profileId === DEFAULT_PROFILE_ID
      ? await RelayModel.find().lean()
      : [];

  return mapEntries.map((r) => {
    const legacyName = LEGACY_RELAY_NAME[r.key];
    const doc = legacyName ? relayDocs.find((d) => d.name === legacyName) : undefined;
    const profileEnabled = (r as { enabled?: boolean }).enabled !== false;
    const enabled = doc ? doc.automationEnabled !== false : profileEnabled;
    return { key: r.key, index: r.index, enabled };
  });
}

// ─── Wire format + MQTT publish ──────────────────────────────────────────────

interface WireRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  triggerMode: "all" | "any";
  triggers: Array<{ sensor: string; op: string; value: number }>;
  turnOn: string[];
  turnOff: string[];
  cutoffMode: "all" | "any";
  cutoffs: Array<{ sensor: string; op: string; value: number }>;
  release: string[];
  minOnMs: number;
  minOffMs: number;
  cooldownMs: number;
}

async function buildWirePayload(profileId: string): Promise<string | null> {
  const ruleDocs = await AutomationRuleModel.find({
    $or: [{ profileIds: { $size: 0 } }, { profileIds: profileId }],
    // push only sensible, currently-valid rules
  })
    .sort({ priority: 1, createdAt: 1 })
    .lean();

  // Stage-scoped rules are left out entirely rather than shipped disabled: the
  // ESP has a fixed 16-rule table, so the slots belong to the rules that can
  // actually fire in the stage the crop is in.
  const activeStageKey = await getActiveStageKey();
  let stageFiltered = 0;

  // Try to validate each doc against the input schema; skip anything corrupted.
  const rules: WireRule[] = [];
  for (const doc of ruleDocs) {
    if (!ruleAppliesToStage(doc.stageKeys, activeStageKey)) {
      stageFiltered += 1;
      continue;
    }
    const parsed = RuleInputSchema.safeParse({
      name: doc.name,
      enabled: doc.enabled,
      priority: doc.priority,
      profileIds: doc.profileIds ?? [],
      stageKeys: doc.stageKeys ?? [],
      triggerMode: doc.triggerMode ?? "all",
      triggers: (doc.triggers ?? []).map((t) => ({ sensor: t.sensor, operator: t.operator, value: t.value })),
      actions: { turnOn: doc.actions?.turnOn ?? [], turnOff: doc.actions?.turnOff ?? [] },
      cutoffMode: doc.cutoffMode ?? "any",
      cutoffs: (doc.cutoffs ?? []).map((t) => ({ sensor: t.sensor, operator: t.operator, value: t.value })),
      offActions: { turnOff: doc.offActions?.turnOff ?? [] },
      minOnMs: doc.minOnMs ?? 0,
      minOffMs: doc.minOffMs ?? 0,
      cooldownMs: doc.cooldownMs ?? 0,
    });
    if (!parsed.success) {
      logger.warn({ id: String((doc._id as { toString(): string }).toString()), issues: parsed.error.issues }, "Skipping invalid rule in wire payload");
      continue;
    }
    try {
      assertRuleSane(parsed.data);
    } catch {
      continue;
    }
    rules.push({
      id: (doc._id as { toString(): string }).toString(),
      name: parsed.data.name,
      enabled: parsed.data.enabled,
      priority: parsed.data.priority,
      triggerMode: parsed.data.triggerMode,
      triggers: parsed.data.triggers.map((t) => ({ sensor: t.sensor, op: t.operator, value: t.value })),
      turnOn: parsed.data.actions.turnOn,
      turnOff: parsed.data.actions.turnOff,
      cutoffMode: parsed.data.cutoffMode,
      cutoffs: parsed.data.cutoffs.map((t) => ({ sensor: t.sensor, op: t.operator, value: t.value })),
      release: parsed.data.offActions.turnOff,
      minOnMs: parsed.data.minOnMs,
      minOffMs: parsed.data.minOffMs,
      cooldownMs: parsed.data.cooldownMs,
    });
  }

  // Global kill-switch: repurposes the emergency-stop flag so a paused system
  // also silences edge-executed rules, not just the old server-side one.
  const settings = await SettingsModel.findById("default").select("automationPaused").lean();
  const masterEnabled = settings?.automationPaused ? false : true;

  const devices = await getRelayMap(profileId);

  if (stageFiltered > 0) {
    logger.info(
      { activeStageKey, stageFiltered, published: rules.length },
      "Rules filtered to the active crop stage",
    );
  }

  return JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    masterEnabled,
    stage: activeStageKey,
    devices,
    rules,
  });
}

function topicFor(profileId: string): string {
  return profileId === DEFAULT_PROFILE_ID ? RULES_TOPIC : `fridge/${profileId}/rules`;
}

/** Publishes the retained rule payload for one device profile. */
export async function publishRulePayload(profileId: string): Promise<void> {
  const client = getMqttClient();
  if (!client) return;
  const payload = await buildWirePayload(profileId);
  if (!payload) return;
  const topic = topicFor(profileId);

  await new Promise<void>((resolve) => {
    client.publish(topic, payload, { retain: true }, (err) => {
      if (err) {
        logger.error({ err, topic }, "Failed to publish rules to MQTT");
      } else {
        logger.info({ topic, ruleCount: JSON.parse(payload).rules.length }, "Rules published to MQTT (retained)");
      }
      resolve();
    });
  });
}

/** Publishes rules to every profile referenced by the changed rules. */
export async function publishAffectedProfiles(profileIds: string[]): Promise<void> {
  await ensureMainProfile();
  const ids = new Set(profileIds.length > 0 ? profileIds : [DEFAULT_PROFILE_ID]);
  for (const profileId of ids) {
    await publishRulePayload(profileId);
  }
  if (profileIds.length > 0) {
    // global rules (empty profileIds) always need a push as well
    await publishRulePayload(DEFAULT_PROFILE_ID);
  }
}

/** Publishes the current ruleset for every known device profile. */
export async function publishAllRulePayloads(): Promise<void> {
  await ensureMainProfile();
  const profiles = await DeviceProfileModel.find({ enabled: true }).select("profileId").lean();
  const ids = profiles.length > 0 ? profiles.map((p) => p.profileId) : [DEFAULT_PROFILE_ID];
  for (const profileId of ids) {
    await publishRulePayload(profileId);
  }
}
#include "rule_engine.h"
#include "config.h"

#include <ArduinoJson.h>
#include <Preferences.h>
#include <cstdlib>
#include <cstring>

// ─── Built-in relay registry fallback (matches server DEFAULT_RELAY_MAP) ────
static const char* BUILTIN_DEVICE_KEYS[RULE_ENGINE_MAX_DEVICES] = {
    "fan", "ac", "mist_maker", "uv",
};

// ─── Condition evaluation ────────────────────────────────────────────────────

bool RuleCondition::evaluate(const SensorReading& r) const {
  float v = 0.0f;
  switch (sensor) {
    case RuleSensor::AIR_TEMP:
      if (!r.shtValid) return false;
      v = r.temperatureC;
      break;
    case RuleSensor::HUMIDITY:
      if (!r.shtValid) return false;
      v = r.humidityPct;
      break;
    case RuleSensor::CO2:
      if (!r.scdValid) return false;
      v = static_cast<float>(r.co2Ppm);
      break;
    case RuleSensor::SCD_TEMP:
      if (!r.scdValid) return false;
      v = r.scdTempC;
      break;
    case RuleSensor::SCD_HUM:
      if (!r.scdValid) return false;
      v = r.scdHumPct;
      break;
    case RuleSensor::COMPOST_TEMP:
      if (!r.dsValid) return false;
      v = r.compostTempC;
      break;
    default:
      return false;
  }

  switch (op) {
    case RuleOperator::GT: return v > value;
    case RuleOperator::GE: return v >= value;
    case RuleOperator::LT: return v < value;
    case RuleOperator::LE: return v <= value;
    case RuleOperator::EQ: return v == value;
    case RuleOperator::NE: return v != value;
  }
  return false;
}

// ─── Compile helpers ─────────────────────────────────────────────────────────

static RuleSensor parseSensor(const char* key) {
  if (strcmp(key, "air_temp") == 0) return RuleSensor::AIR_TEMP;
  if (strcmp(key, "humidity") == 0) return RuleSensor::HUMIDITY;
  if (strcmp(key, "co2") == 0) return RuleSensor::CO2;
  if (strcmp(key, "scd_temp") == 0) return RuleSensor::SCD_TEMP;
  if (strcmp(key, "scd_hum") == 0) return RuleSensor::SCD_HUM;
  if (strcmp(key, "compost_temp") == 0) return RuleSensor::COMPOST_TEMP;
  return RuleSensor::UNKNOWN;
}

static RuleOperator parseOperator(const char* key) {
  if (strcmp(key, ">") == 0) return RuleOperator::GT;
  if (strcmp(key, ">=") == 0) return RuleOperator::GE;
  if (strcmp(key, "<") == 0) return RuleOperator::LT;
  if (strcmp(key, "<=") == 0) return RuleOperator::LE;
  if (strcmp(key, "==") == 0) return RuleOperator::EQ;
  if (strcmp(key, "!=") == 0) return RuleOperator::NE;
  return RuleOperator::GT;
}

static bool parseCondition(JsonVariantConst src, RuleCondition& out) {
  const char* sensor = src["sensor"] | "";
  const char* op = src["op"] | "";
  if (strlen(sensor) == 0) return false;

  out.sensor = parseSensor(sensor);
  if (out.sensor == RuleSensor::UNKNOWN) {
    Serial.printf("[RULES] Skipping condition — unknown sensor \"%s\"\n", sensor);
    return false;
  }
  out.op = parseOperator(op);
  out.value = src["value"] | 0.0f;
  return true;
}

static bool parseMatchMode(const char* mode, bool defaultAll) {
  if (strcmp(mode, "any") == 0) return false;
  if (strcmp(mode, "all") == 0) return true;
  return defaultAll;
}

// ─── RuleEngine ──────────────────────────────────────────────────────────────

void RuleEngine::begin() {
  // Seed the built-in registry so rules work even if the server never sends
  // a "devices" block (legacy publishing).
  clearRules();
  deviceCount_ = 0;
  for (uint8_t i = 0; i < 4 && i < RULE_ENGINE_MAX_DEVICES; ++i) {
    strncpy(deviceKeys_[i], BUILTIN_DEVICE_KEYS[i], sizeof(deviceKeys_[i]) - 1);
    deviceKeys_[i][sizeof(deviceKeys_[i]) - 1] = '\0';
    deviceIndex_[i] = i;
    deviceEnabled_[i] = true;
    ++deviceCount_;
  }
  loadFromNvs();
}

void RuleEngine::clearRules() {
  ruleCount_ = 0;
  for (uint8_t i = 0; i < RULE_ENGINE_MAX_RULES; ++i) {
    rules_[i] = AutomationRule{};
  }
}

void RuleEngine::setMasterEnabled(bool enabled) {
  masterEnabled_ = enabled;
  Serial.printf("[RULES] Master automation %s\n", enabled ? "ENABLED" : "DISABLED");
}

void RuleEngine::setRuleEnabled(uint16_t index, bool enabled) {
  if (index >= ruleCount_) return;
  rules_[index].enabled = enabled;
  Serial.printf("[RULES] Rule #%u %s\n",
                rules_[index].id,
                enabled ? "ENABLED" : "DISABLED");
}

bool RuleEngine::registerDeviceKey(const char* key, uint8_t index, bool enabled) {
  for (uint8_t i = 0; i < deviceCount_; ++i) {
    if (strcmp(deviceKeys_[i], key) == 0) {
      deviceIndex_[i] = index;
      deviceEnabled_[i] = enabled;
      return true;
    }
  }
  if (deviceCount_ >= RULE_ENGINE_MAX_DEVICES) {
    Serial.printf("[RULES] Device registry full — dropping \"%s\"\n", key);
    return false;
  }
  strncpy(deviceKeys_[deviceCount_], key, sizeof(deviceKeys_[deviceCount_]) - 1);
  deviceKeys_[deviceCount_][sizeof(deviceKeys_[deviceCount_]) - 1] = '\0';
  deviceIndex_[deviceCount_] = index;
  deviceEnabled_[deviceCount_] = enabled;
  ++deviceCount_;
  return true;
}

bool RuleEngine::isChannelEnabled(uint8_t channel) const {
  for (uint8_t i = 0; i < deviceCount_; ++i) {
    if (deviceIndex_[i] == channel) return deviceEnabled_[i];
  }
  // Unknown channel — treat as enabled so a registry-less payload keeps the
  // old behaviour.
  return true;
}

bool RuleEngine::resolveMask(JsonVariantConst keys, uint32_t& mask) const {
  mask = 0;
  for (JsonVariantConst k : keys.as<JsonArrayConst>()) {
    const char* key = k | "";
    bool found = false;
    for (uint8_t i = 0; i < deviceCount_; ++i) {
      if (strcmp(deviceKeys_[i], key) == 0) {
        mask |= (1UL << deviceIndex_[i]);
        found = true;
        break;
      }
    }
    if (!found) {
      Serial.printf("[RULES] Unknown relay key \"%s\" — rule skipped\n", key);
      return false;
    }
  }
  return true;
}

bool RuleEngine::compileFromDoc(JsonVariantConst doc) {
  clearRules();

  masterEnabled_ = doc["masterEnabled"] | true;

  // Device registry is fully replaced on every payload. None → built-ins.
  deviceCount_ = 0;
  if (doc["devices"].is<JsonArrayConst>()) {
    for (JsonVariantConst dev : doc["devices"].as<JsonArrayConst>()) {
      const char* key = dev["key"] | "";
      if (strlen(key) == 0) continue;
      registerDeviceKey(key,
                        static_cast<uint8_t>(dev["index"] | 0),
                        dev["enabled"] | true);
    }
  } else {
    for (uint8_t i = 0; i < 4 && i < RULE_ENGINE_MAX_DEVICES; ++i) {
      strncpy(deviceKeys_[i], BUILTIN_DEVICE_KEYS[i], sizeof(deviceKeys_[i]) - 1);
      deviceKeys_[i][sizeof(deviceKeys_[i]) - 1] = '\0';
      deviceIndex_[i] = i;
      deviceEnabled_[i] = true;
      ++deviceCount_;
    }
  }

  const JsonArrayConst rules = doc["rules"].as<JsonArrayConst>();
  for (JsonVariantConst src : rules) {
    if (ruleCount_ >= RULE_ENGINE_MAX_RULES) {
      Serial.printf("[RULES] Max rules reached (%d) — dropping extras\n", RULE_ENGINE_MAX_RULES);
      break;
    }

    AutomationRule& out = rules_[ruleCount_];
    const char* idStr = src["id"] | "";
    const char* ruleName = src["name"] | "?";
    out.id = static_cast<uint32_t>(strtoul(idStr, nullptr, 16));
    out.enabled = src["enabled"] | true;
    out.triggerAll = parseMatchMode(src["triggerMode"] | "all", true);
    out.cutoffAll = parseMatchMode(src["cutoffMode"] | "any", false);
    out.minOnMs = src["minOnMs"] | 0UL;
    out.minOffMs = src["minOffMs"] | 0UL;
    out.cooldownMs = src["cooldownMs"] | 0UL;

    // Triggers
    const JsonArrayConst triggers = src["triggers"].as<JsonArrayConst>();
    for (JsonVariantConst t : triggers) {
      if (out.triggerCount >= RULE_ENGINE_MAX_CONDITIONS) break;
      RuleCondition cond;
      if (parseCondition(t, cond)) {
        out.triggers[out.triggerCount++] = cond;
      }
    }

    // Actions
    if (!resolveMask(src["turnOn"].as<JsonArrayConst>(), out.onMask)) continue;
    if (!resolveMask(src["turnOff"].as<JsonArrayConst>(), out.offMask)) continue;

    // Cutoffs / target
    const JsonArrayConst cutoffs = src["cutoffs"].as<JsonArrayConst>();
    for (JsonVariantConst c : cutoffs) {
      if (out.cutoffCount >= RULE_ENGINE_MAX_CONDITIONS) break;
      RuleCondition cond;
      if (parseCondition(c, cond)) {
        out.cutoffs[out.cutoffCount++] = cond;
      }
    }

    if (!resolveMask(src["release"].as<JsonArrayConst>(), out.releaseMask)) continue;

    if (out.triggerCount == 0 || out.cutoffCount == 0) {
      Serial.printf("[RULES] Rule \"%s\" needs ≥1 trigger and ≥1 cutoff — skipped\n",
                    ruleName);
      continue;
    }
    if (out.onMask == 0 && out.offMask == 0) {
      Serial.printf("[RULES] Rule \"%s\" commands no relays — skipped\n", ruleName);
      continue;
    }

    Serial.printf(
        "[RULES] #%u \"%s\" prio=%d %s | %u triggers(%s), %u cutoffs(%s) | ON=%08lX OFF=%08lX REL=%08lX\n",
        out.id,
        ruleName,
        static_cast<int>(src["priority"] | 0),
        out.enabled ? "on" : "off",
        out.triggerCount,
        out.triggerAll ? "all" : "any",
        out.cutoffCount,
        out.cutoffAll ? "all" : "any",
        static_cast<unsigned long>(out.onMask),
        static_cast<unsigned long>(out.offMask),
        static_cast<unsigned long>(out.releaseMask));

    ++ruleCount_;
  }

  Serial.printf("[RULES] Compiled %u rule(s), master %s\n",
                ruleCount_, masterEnabled_ ? "enabled" : "disabled");
  return true;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

void RuleEngine::persistJson(const char* json) {
  Preferences prefs;
  prefs.begin(RULE_ENGINE_NVS_NS, false);
  if (json && strlen(json) > 0) {
    prefs.putString(RULE_ENGINE_NVS_KEY, json);
    Serial.printf("[RULES] Persisted %u bytes to NVS\n", static_cast<unsigned>(strlen(json)));
  } else {
    prefs.remove(RULE_ENGINE_NVS_KEY);
  }
  prefs.end();
}

void RuleEngine::loadFromNvs() {
  Preferences prefs;
  prefs.begin(RULE_ENGINE_NVS_NS, true);
  const String stored = prefs.getString(RULE_ENGINE_NVS_KEY, "");
  prefs.end();
  if (stored.length() == 0) {
    Serial.println("[RULES] No rules in NVS — waiting for server payload");
    return;
  }

  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, stored);
  if (err) {
    Serial.printf("[RULES] Stored JSON corrupt (%s) — clearing\n", err.c_str());
    persistJson(nullptr);
    return;
  }
  Serial.printf("[RULES] Loading %u-byte ruleset from NVS\n", static_cast<unsigned>(stored.length()));
  compileFromDoc(doc);
}

void RuleEngine::loadFromJson(const uint8_t* payload, unsigned int length) {
  if (!payload || length == 0) return;

  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, payload, length);
  if (err) {
    Serial.printf("[RULES] JSON parse error: %s\n", err.c_str());
    return;
  }
  if (!doc.is<JsonObject>()) {
    Serial.println("[RULES] Expected a JSON object payload");
    return;
  }

  char raw[4096];
  const size_t needed = measureJson(doc);
  if (needed == 0 || needed >= sizeof(raw)) {
    Serial.printf("[RULES] Payload too large for buffer (%u bytes) — not persisted\n",
                  static_cast<unsigned>(needed));
  } else {
    const size_t len = serializeJson(doc, raw, sizeof(raw));
    raw[len] = '\0';
    persistJson(raw);
  }

  compileFromDoc(doc);
  Serial.printf("[RULES] MQTT rules payload received — ready\n");
}

// ─── Execution ───────────────────────────────────────────────────────────────

void RuleEngine::applyMask(RelayController& relays, uint32_t mask, bool on) const {
  for (uint8_t i = 0; i < RELAY_COUNT; ++i) {
    if (!(mask & (1UL << i))) continue;
    if (!isChannelEnabled(i)) continue;
    if (relays.isManualOverride(i)) continue;
    relays.setRelay(i, on);
  }
}

static bool matchConditions(const RuleCondition* conds, uint8_t count,
                            bool requireAll, const SensorReading& reading) {
  if (count == 0) return false;
  if (requireAll) {
    for (uint8_t i = 0; i < count; ++i) {
      if (!conds[i].evaluate(reading)) return false;
    }
    return true;
  }
  for (uint8_t i = 0; i < count; ++i) {
    if (conds[i].evaluate(reading)) return true;
  }
  return false;
}

void RuleEngine::evaluate(const SensorReading& reading, RelayController& relays) {
  if (!masterEnabled_) return;

  const unsigned long nowMs = millis();

  for (int16_t r = ruleCount_ - 1; r >= 0; --r) {
    AutomationRule& rule = rules_[r];
    if (!rule.enabled) continue;

    const bool triggered =
        matchConditions(rule.triggers, rule.triggerCount, rule.triggerAll, reading);
    const bool cutoff =
        matchConditions(rule.cutoffs, rule.cutoffCount, rule.cutoffAll, reading);

    if (rule.groupActive) {
      if (cutoff && (nowMs - rule.groupActiveSinceMs) >= rule.minOnMs) {
        applyMask(relays, rule.releaseMask, false);
        Serial.printf("[RULES] #%u cutoff fired (relMask=0x%02X) — releasing group\n",
            rule.id, rule.releaseMask);
        rule.groupActive = false;
        rule.lastActionMs = nowMs;
      } else if (cutoff) {
        Serial.printf("[RULES] #%u cutoff but minOnMs not yet (%lu/%lu)\n",
            rule.id, nowMs - rule.groupActiveSinceMs, rule.minOnMs);
      }
    } else if (triggered) {
      const unsigned long since = nowMs - rule.lastActionMs;
      if (since >= rule.cooldownMs && since >= rule.minOffMs) {
        applyMask(relays, rule.onMask, true);
        applyMask(relays, rule.offMask, false);
        Serial.printf("[RULES] #%u triggered (onMask=0x%02X) — activating group\n",
            rule.id, rule.onMask);
        rule.groupActive = true;
        rule.groupActiveSinceMs = nowMs;
        rule.lastActionMs = nowMs;
      }
    }
  }
}

/**
 * Boot-straps the rule engine with the current sensor reading.
 *
 * After a reboot, relay states are restored from NVS but the rule latch
 * states are all false (fresh). This means a relay that was ON when power
 * was lost — and should still be ON — will stay ON but the rule that
 * activated it has no latch, so its cutoff can never fire and the rule can
 * never re-decide.
 *
 * By evaluating the current reading with the latch machine starting from
 * IDLE, every rule that should be active immediately latches and
 * asserts its ON mask. This also handles the first-cycle case where
 * all relays were OFF at boot: the triggered==false path correctly
 * leaves everything OFF.
 *
 * Call this exactly once from setup() after loadFromNvs().
 */
void RuleEngine::bootstrap(const SensorReading& reading, RelayController& relays) {
  if (!masterEnabled_) return;

  Serial.printf("[RULES] Bootstrap: evaluating %u rules against current reading\n", ruleCount_);

  const unsigned long nowMs = millis();

  for (int16_t r = ruleCount_ - 1; r >= 0; --r) {
    AutomationRule& rule = rules_[r];
    if (!rule.enabled) continue;

    const bool triggered =
        matchConditions(rule.triggers, rule.triggerCount, rule.triggerAll, reading);
    const bool cutoff =
        matchConditions(rule.cutoffs, rule.cutoffCount, rule.cutoffAll, reading);

    Serial.printf("[RULES] Bootstrap #%u: triggered=%d cutoff=%d\n",
        rule.id, triggered, cutoff);

    if (triggered) {
      applyMask(relays, rule.onMask, true);
      applyMask(relays, rule.offMask, false);
      Serial.printf("[BOOT] #%u ON (mask=0x%02X) — latch set\n",
          rule.id, rule.onMask);
      rule.groupActive = true;
      rule.groupActiveSinceMs = nowMs;
      rule.lastActionMs = nowMs;
    } else {
      applyMask(relays, rule.releaseMask, false);
      Serial.printf("[BOOT] #%u OFF — no trigger, releaseMask=0x%02X\n",
          rule.id, rule.releaseMask);
      rule.groupActive = false;
      rule.lastActionMs = 0;
    }
  }
}
#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include "relay_controller.h"
#include "sensor_manager.h"

// ─── Edge-executed dynamic rule engine ───────────────────────────────────────
//
// The ESP receives a retained JSON document on MQTT_TOPIC_RULES, parses it
// with ArduinoJson, compiles it into a compact in-memory rule table, and
// persists the raw JSON to NVS flash. The system then executes the rules in
// loop() from the locally-stored copy — no firmware re-flash is ever required,
// and automation keeps working even when the network drops.
//
// Hysteresis is structural: a rule latches its group ON while ALL triggers
// hold, and releases it only when a cutoff fires. Because trigger and cutoff
// thresholds differ, a relay that turned ON never gets turned OFF by the same
// boundary that turned it on. minOnMs / minOffMs / cooldownMs guarantee a
// minimum dwell time in each state (anti short-cycling).
//
// Memory: the rule table is bounded and allocated at compile time for one
// flavor, then the parsed JSON document is discarded. Reduce MAX_RULES or
// MAX_CONDITIONS if deploying on an ESP8266 with limited heap.

#define RULE_ENGINE_MAX_RULES 16
#define RULE_ENGINE_MAX_CONDITIONS 8
#define RULE_ENGINE_MAX_DEVICES 8
#define RULE_ENGINE_NVS_NS "myco"
#define RULE_ENGINE_NVS_KEY "rules"

enum class RuleOperator : uint8_t { GT, GE, LT, LE, EQ, NE };

// Sensor key → SensorReading field. UNKNOWN rules are rejected at compile time.
enum class RuleSensor : uint8_t {
  AIR_TEMP,       // SHT40 temperatureC  (shtValid)
  HUMIDITY,       // SHT40 humidityPct   (shtValid)
  CO2,            // SCD40 co2Ppm        (scdValid)
  SCD_TEMP,       // SCD40 scdTempC      (scdValid)
  SCD_HUM,        // SCD40 scdHumPct     (scdValid)
  COMPOST_TEMP,   // DS18B20 compostTempC (dsValid)
  UNKNOWN
};

struct RuleCondition {
  RuleSensor sensor = RuleSensor::UNKNOWN;
  RuleOperator op = RuleOperator::GT;
  float value = 0.0f;

  // Returns false when the referenced sensor is offline so a dead sensor never
  // flips a relay (fail-safe = hold last commanded state).
  bool evaluate(const SensorReading& r) const;
};

struct AutomationRule {
  uint32_t id = 0;
  bool enabled = false;
  bool triggerAll = true;               // "all" → AND, "any" → OR
  uint8_t triggerCount = 0;
  RuleCondition triggers[RULE_ENGINE_MAX_CONDITIONS];
  uint32_t onMask = 0;                  // relays forced ON  when trigger fires
  uint32_t offMask = 0;                 // relays forced OFF when trigger fires
  bool cutoffAll = false;               // true → ALL cutoffs must fire, false → ANY
  uint8_t cutoffCount = 0;
  RuleCondition cutoffs[RULE_ENGINE_MAX_CONDITIONS];
  uint32_t releaseMask = 0;             // relays released when cutoff fires
  uint32_t minOnMs = 0;
  uint32_t minOffMs = 0;
  uint32_t cooldownMs = 0;

  // Runtime latch state
  bool groupActive = false;
  uint32_t groupActiveSinceMs = 0;
  uint32_t lastActionMs = 0;
};

class RuleEngine {
 public:
  void begin();                                  // load persisted JSON from NVS
  void loadFromJson(const uint8_t* payload, unsigned int length);
  void evaluate(const SensorReading& reading, RelayController& relays);
  // Bootstraps the rule engine with the current reading so stale relay
  // states from NVS are immediately reconciled with the rules.
  void bootstrap(const SensorReading& reading, RelayController& relays);
  void setMasterEnabled(bool enabled);
  bool masterEnabled() const { return masterEnabled_; }
  uint16_t ruleCount() const { return ruleCount_; }
  const AutomationRule* rules() const { return rules_; }
  void setRuleEnabled(uint16_t index, bool enabled);
private:
  bool compileFromDoc(JsonVariantConst doc);
  bool resolveMask(JsonVariantConst keys, uint32_t& mask) const;
  bool registerDeviceKey(const char* key, uint8_t index, bool enabled);
  bool isChannelEnabled(uint8_t channel) const;
  void persistJson(const char* json);
  void loadFromNvs();
  void applyMask(RelayController& relays, uint32_t mask, bool on) const;
  void clearRules();

  AutomationRule rules_[RULE_ENGINE_MAX_RULES];
  uint16_t ruleCount_ = 0;
  bool masterEnabled_ = true;
  // Dynamically-published device registry: relay key -> channel index.
  char deviceKeys_[RULE_ENGINE_MAX_DEVICES][20];
  uint8_t deviceIndex_[RULE_ENGINE_MAX_DEVICES];
  bool deviceEnabled_[RULE_ENGINE_MAX_DEVICES];
  uint8_t deviceCount_ = 0;
};
#include "relay_controller.h"
#include "config.h"

void RelayController::begin() {
  for (uint8_t i = 0; i < RELAY_COUNT; ++i) {
    pinMode(PIN_RELAY_MAP[i], OUTPUT);
    writePin(i, false);

    Serial.printf(
        "[RELAY] %s -> GPIO %d (%s) = OFF\n",
        RELAY_IN_LABEL[i],
        PIN_RELAY_MAP[i],
        RELAY_DEVICE_NAME[i]);
  }
  stateChanged_ = false;
  Serial.println("[RELAY] All relays safe — pins held OFF level");

  loadState();
}

void RelayController::loadState() {
  Preferences prefs;
  if (!prefs.begin("relays", false)) {
    Serial.println("[RELAY] NVS open failed — using default OFF states");
    return;
  }

  for (uint8_t i = 0; i < RELAY_COUNT; ++i) {
    char key[8];
    snprintf(key, sizeof(key), "r%u", i + 1);
    const bool exists = prefs.isKey(key);
    const bool saved = exists ? prefs.getBool(key, false) : false;
    states_[i] = saved;
    writePin(i, saved);
    Serial.printf("[RELAY] %s (GPIO %d) RESTORED -> %s\n",
                  RELAY_IN_LABEL[i], PIN_RELAY_MAP[i], saved ? "ON" : "OFF");

    char moKey[16];
    snprintf(moKey, sizeof(moKey), "mo%u", i + 1);
    manualOverride_[i] = prefs.getBool(moKey, false);
  }
  prefs.end();

  // Force-clear any stale manual-override flag saved by older firmware that
  // latched the flag during staggered startup. The rules engine needs to be
  // able to drive the relays normally after boot.
  for (uint8_t i = 0; i < RELAY_COUNT; ++i) {
    if (manualOverride_[i]) {
      manualOverride_[i] = false;
      Serial.printf("[RELAY] %s (GPIO %d) stale manual override cleared\n",
                    RELAY_IN_LABEL[i], PIN_RELAY_MAP[i]);
    }
  }
  saveState();

  Serial.println("[RELAY] State restored from NVS after reboot");
}

void RelayController::saveState() {
  Preferences prefs;
  if (!prefs.begin("relays", false)) {
    Serial.println("[RELAY] NVS save failed");
    return;
  }

  for (uint8_t i = 0; i < RELAY_COUNT; ++i) {
    char key[8];
    snprintf(key, sizeof(key), "r%u", i + 1);
    prefs.putBool(key, states_[i]);

    char moKey[16];
    snprintf(moKey, sizeof(moKey), "mo%u", i + 1);
    prefs.putBool(moKey, manualOverride_[i]);
  }
  prefs.end();
}

void RelayController::writePin(uint8_t index, bool on) {
  if (index >= RELAY_COUNT) return;
  const int level = (on == RELAY_ACTIVE_LOW) ? LOW : HIGH;
  digitalWrite(PIN_RELAY_MAP[index], level);
}

void RelayController::setRelay(uint8_t index, bool on) {
  if (index >= RELAY_COUNT) return;
  if (states_[index] == on) return;

  states_[index] = on;
  writePin(index, on);
  stateChanged_ = true;
  saveState();

  Serial.printf(
      "[RELAY] %s (GPIO %d) %s -> %s\n",
      RELAY_IN_LABEL[index],
      PIN_RELAY_MAP[index],
      RELAY_DEVICE_NAME[index],
      on ? "ON" : "OFF");
}

void RelayController::setManualOverride(uint8_t index, bool on) {
  if (index >= RELAY_COUNT) return;
  if (manualOverride_[index] == on) return;
  manualOverride_[index] = on;
  saveState();
  Serial.printf(
      "[RELAY] %s (GPIO %d) manual override -> %s\n",
      RELAY_IN_LABEL[index],
      PIN_RELAY_MAP[index],
      on ? "ON" : "OFF");
}

bool RelayController::isManualOverride(uint8_t index) const {
  if (index >= RELAY_COUNT) return false;
  return manualOverride_[index];
}

bool RelayController::getRelay(uint8_t index) const {
  if (index >= RELAY_COUNT) return false;
  return states_[index];
}

void RelayController::getRelayArray(int out[RELAY_COUNT]) const {
  for (uint8_t i = 0; i < RELAY_COUNT; ++i) {
    out[i] = states_[i] ? 1 : 0;
  }
}

bool RelayController::hasStateChanged() const {
  return stateChanged_;
}

bool RelayController::consumeStateChanged() {
  if (!stateChanged_) return false;
  stateChanged_ = false;
  return true;
}

void RelayController::clearManualOverride() {
  for (uint8_t i = 0; i < RELAY_COUNT; ++i) {
    if (manualOverride_[i]) {
      manualOverride_[i] = false;
      Serial.printf("[RELAY] %s (GPIO %d) manual override cleared\n",
                    RELAY_IN_LABEL[i], PIN_RELAY_MAP[i]);
    }
  }
  saveState();
}

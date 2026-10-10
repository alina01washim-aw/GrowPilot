#pragma once

#include <Arduino.h>
#include "config.h"
#include <Preferences.h>

class RelayController {
public:
  void begin();
  void setRelay(uint8_t index, bool on);
  bool getRelay(uint8_t index) const;
  void getRelayArray(int out[RELAY_COUNT]) const;
  bool hasStateChanged() const;
  bool consumeStateChanged();
  void loadState();
  void saveState();
  void setManualOverride(uint8_t index, bool on);
  bool isManualOverride(uint8_t index) const;
  void clearManualOverride();

private:
  bool states_[RELAY_COUNT] = {};
  bool stateChanged_ = false;
  bool manualOverride_[RELAY_COUNT] = {};

  void writePin(uint8_t index, bool on);
};


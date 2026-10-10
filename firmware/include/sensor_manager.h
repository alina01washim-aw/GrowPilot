#pragma once

#include <Arduino.h>

struct SensorReading {
  float temperatureC = 0.0f; // SHT40 Temp — only meaningful when shtValid
  float humidityPct = 0.0f;  // SHT40 Hum — only meaningful when shtValid
  uint16_t co2Ppm = 0;       // SCD40 CO2 — only meaningful when scdValid
  float scdTempC = 0.0f;     // SCD40 Temp — only meaningful when scdValid
  float scdHumPct = 0.0f;    // SCD40 Hum — only meaningful when scdValid
  float compostTempC = 0.0f; // DS18B20 Temp — only meaningful when dsValid
  bool valid = false;
  bool shtValid = false;
  bool scdValid = false;
  bool dsValid = false;
};

class SensorManager {
public:
  bool begin();
  bool read(SensorReading& out);
  bool isHealthy() const;
  uint32_t consecutiveErrors() const;

private:
  bool scdInitialized_ = false;
  bool shtInitialized_ = false;
  bool dsInitialized_ = false;
  bool wireStarted_ = false;
  bool scdContacted_ = false; // first power-on settle done
  uint32_t errorCount_ = 0;
  uint32_t scdErrorCount_ = 0;
  unsigned long lastBeginAttemptMs_ = 0;
  unsigned long lastScdDataMs_ = 0;
  unsigned long lastScdReadAttemptMs_ = 0;

  // SCD40 recovery state
  unsigned long scdRecoveryNextAttemptMs_ = 0;
  uint8_t scdRecoveryAttempt_ = 0;
  static constexpr uint8_t MAX_SCD_RECOVERY_ATTEMPTS = 8;
  static constexpr unsigned long SCD_RECOVERY_BASE_DELAY_MS = 1000UL;
  static constexpr unsigned long SCD_RECOVERY_MAX_DELAY_MS = 60000UL;

  void registerSensorError();
  void scdRecoveryResetBus();
  bool scdRecoveryScan();
  void scheduleScdRecovery();
  bool tryScdRecovery();
};

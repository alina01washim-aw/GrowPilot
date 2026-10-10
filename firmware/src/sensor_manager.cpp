#include "sensor_manager.h"
#include "config.h"

#include <Wire.h>
#include <SensirionCore.h>
#include <SensirionI2cScd4x.h>
#include <Adafruit_SHT4x.h>
#include <OneWire.h>
#include <DallasTemperature.h>

static SensirionI2cScd4x scd4x;
static Adafruit_SHT4x sht4x = Adafruit_SHT4x();
static OneWire oneWire(PIN_ONE_WIRE_BUS);
static DallasTemperature ds18b20(&oneWire);

void logScdError(const char* action, int16_t error) {
  if (error == 0) return;
  char msg[64];
  errorToString(static_cast<uint16_t>(error), msg, sizeof(msg));
  Serial.printf("[SCD40] %s failed: %s (0x%04X)\n", action, msg, static_cast<uint16_t>(error));
}

void SensorManager::scdRecoveryResetBus() {
  Serial.println("[SCD40] Recovery: Resetting I2C bus");
  Wire.end();
  delay(100);
  pinMode(PIN_I2C_SDA, INPUT_PULLUP);
  pinMode(PIN_I2C_SCL, INPUT_PULLUP);
  delay(100);
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 40000);
  Wire.setClock(40000);
  delay(200);
}

bool SensorManager::scdRecoveryScan() {
  Serial.println("[SCD40] Recovery: Scanning for device at 0x62");
  byte error;
  Wire.beginTransmission(0x62);
  error = Wire.endTransmission();
  if (error == 0) {
    Serial.println("[SCD40] Recovery: Device ACK at 0x62");
    return true;
  }
  Serial.printf("[SCD40] Recovery: No ACK at 0x62 (error=0x%02X)\n", error);
  return false;
}

void SensorManager::scheduleScdRecovery() {
  if (scdRecoveryAttempt_ >= MAX_SCD_RECOVERY_ATTEMPTS) {
    Serial.println("[SCD40] Recovery: Max attempts reached, giving up until next boot");
    scdRecoveryNextAttemptMs_ = 0;
    return;
  }
  unsigned long delayMs = SCD_RECOVERY_BASE_DELAY_MS * (1UL << scdRecoveryAttempt_);
  if (delayMs > SCD_RECOVERY_MAX_DELAY_MS) delayMs = SCD_RECOVERY_MAX_DELAY_MS;
  scdRecoveryNextAttemptMs_ = millis() + delayMs;
  Serial.printf("[SCD40] Recovery: Next attempt in %lu ms (attempt %u/%u)\n",
                delayMs, scdRecoveryAttempt_ + 1, MAX_SCD_RECOVERY_ATTEMPTS);
}

bool SensorManager::tryScdRecovery() {
  if (scdRecoveryNextAttemptMs_ == 0 || millis() < scdRecoveryNextAttemptMs_) {
    return false;
  }
  scdRecoveryAttempt_++;
  scdRecoveryResetBus();
  if (scdRecoveryScan()) {
    scdInitialized_ = false;  // Force re-init via begin()
    scdRecoveryAttempt_ = 0;
    scdRecoveryNextAttemptMs_ = 0;
    Serial.println("[SCD40] Recovery: Device detected, will reinitialize");
    return true;
  }
  scheduleScdRecovery();
  return false;
}

bool SensorManager::begin() {
  if (!wireStarted_) {
    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 40000);
    Wire.setClock(40000);
    wireStarted_ = true;

    // Scan ONLY the configured I2C pins (SDA=21, SCL=22) for our two sensors:
    // SCD40 at 0x62, SHT40 at 0x44
    Serial.println("[I2C] Scanning bus on SDA=21 SCL=22 for SCD40(0x62) & SHT40(0x44)...");
    byte error, address;
    int nDevices = 0;
    bool foundScd40 = false;
    bool foundSht40 = false;
    for (address = 1; address < 127; address++) {
      Wire.beginTransmission(address);
      error = Wire.endTransmission();
      if (error == 0) {
        const char* name = "";
        if (address == 0x44) { name = " (SHT40)"; foundSht40 = true; }
        else if (address == 0x62) { name = " (SCD40)"; foundScd40 = true; }
        Serial.printf("[I2C] Device found at 0x%02X%s\n", address, name);
        nDevices++;
      }
    }
    if (!foundScd40) Serial.println("[I2C] SCD40 (0x62) NOT FOUND — check: VDD=3V3 (NOT 5V), 4.7kΩ pull-ups on SDA/SCL to 3V3, VCC left empty");
    if (!foundSht40) Serial.println("[I2C] SHT40 (0x44) NOT FOUND — check wiring + 4.7kΩ pull-ups on SDA/SCL to 3V3");
    Serial.printf("[I2C] Total devices found: %d\n", nDevices);

    // Check 1-Wire bus on GPIO 4 for DS18B20
    if (oneWire.reset()) {
      Serial.println("[1W] DS18B20 found on GPIO 4");
    } else {
      Serial.println("[1W] DS18B20 NOT FOUND on GPIO 4 — check 4.7kΩ pull-up on DATA to 3V3");
    }
  }

  // Initialize lastScdDataMs_ to now so 30s timeout doesn't trigger on first run
  if (lastScdDataMs_ == 0) {
    lastScdDataMs_ = millis();
  }

  if (!scdInitialized_) {
    // Try SCD40 init with retries (for clones that need multiple attempts)
    int16_t error = 0;
    for (int attempt = 0; attempt < 3; ++attempt) {
      if (attempt > 0) {
        Serial.printf("[SCD40] Init retry %d/3\n", attempt + 1);
        delay(500);
      }
      scd4x.begin(Wire, SCD40_I2C_ADDR_62);

      if (!scdContacted_) {
        delay(2000);  // 2s for clone power-on settle
        scdContacted_ = true;
      }
      scd4x.stopPeriodicMeasurement();
      delay(50);

      // Serial-number handshake is OPTIONAL diagnostics.
      uint64_t serialNumber = 0;
      for (int snAttempt = 0; snAttempt < 2; ++snAttempt) {
        if (snAttempt > 0) delay(250);
        error = scd4x.getSerialNumber(serialNumber);
        if (error == 0) break;
      }
      if (error != 0) {
        logScdError("getSerialNumber", error);
        Serial.println("[SCD40] Serial read failed (clone?) — continuing without it");
      }

      error = scd4x.startPeriodicMeasurement();
      if (error == 0) {
        scdInitialized_ = true;
        lastScdDataMs_ = millis();
        scdRecoveryAttempt_ = 0;  // Reset recovery on success
        scdRecoveryNextAttemptMs_ = 0;
        Serial.println("[SCD40] Initialized");
        break;
      } else {
        logScdError("startPeriodicMeasurement", error);
      }
    }

    if (!scdInitialized_) {
      Serial.println("[SCD40] Init failed after retries — check: VDD=3V3 (NOT 5V), 4.7kΩ pull-ups on SDA/SCL, VCC left empty; scheduling recovery");
      scheduleScdRecovery();
    }
  }

  if (!shtInitialized_) {
    if (sht4x.begin(&Wire)) {
      sht4x.setPrecision(SHT4X_HIGH_PRECISION);
      sht4x.setHeater(SHT4X_NO_HEATER);
      shtInitialized_ = true;
      Serial.println("[SHT40] Initialized");
    } else {
      Serial.println("[SHT40] Failed to find SHT4x sensor");
    }
  }

  if (!dsInitialized_) {
    ds18b20.begin();
    if (ds18b20.getDeviceCount() > 0) {
      dsInitialized_ = true;
      Serial.println("[DS18B20] Initialized");
    } else {
      Serial.println("[DS18B20] Failed to find DS18B20 sensor");
    }
  }

  errorCount_ = 0;
  return scdInitialized_ || shtInitialized_ || dsInitialized_;
}

void SensorManager::registerSensorError() {
  // SCD40 uses its own counter. The old shared errorCount_ was reset to 0 on
  // every cycle where SHT40/DS18B20 succeeded, so a failing SCD40 could never
  // reach the re-init threshold — it stayed "initialized" but silent forever.
  ++errorCount_;
  ++scdErrorCount_;
  if (scdErrorCount_ >= 5) {
    Serial.println("[SCD40] Too many consecutive errors — reinitializing");
    scdInitialized_ = false;
    scdErrorCount_ = 0;
  }
}

bool SensorManager::read(SensorReading& out) {
  out.valid = false;

  const unsigned long nowMs = millis();
  
  // Try SCD40 recovery if not initialized
  if (!scdInitialized_) {
    tryScdRecovery();
  }

  if (!scdInitialized_ || !shtInitialized_ || !dsInitialized_) {
    if (nowMs - lastBeginAttemptMs_ >= SENSOR_SAMPLE_INTERVAL_MS) {
      lastBeginAttemptMs_ = nowMs;
      begin();
    }
  }

  bool haveScd = false;
  if (scdInitialized_) {
    bool dataReady = false;
    const int16_t statusError = scd4x.getDataReadyStatus(dataReady);
    if (statusError == 0 && dataReady) {
      uint16_t co2 = 0;
      float temperature = 0.0f;
      float humidity = 0.0f;
      const int16_t readError = scd4x.readMeasurement(co2, temperature, humidity);
      if (readError == 0) {
        out.co2Ppm = co2;
        out.scdTempC = temperature;
        out.scdHumPct = humidity;
        haveScd = true;
        scdErrorCount_ = 0;
        lastScdDataMs_ = nowMs;
      } else {
        logScdError("readMeasurement", readError);
        registerSensorError();
      }
    } else if (statusError != 0) {
      // Some clones fail the data-ready command itself. Fall back to a timed
      // direct read (SCD4x periodic measurement completes every ~5s).
      logScdError("getDataReadyStatus", statusError);
      if (nowMs - lastScdReadAttemptMs_ >= 5000UL) {
        lastScdReadAttemptMs_ = nowMs;
        uint16_t co2 = 0;
        float temperature = 0.0f;
        float humidity = 0.0f;
        const int16_t readError = scd4x.readMeasurement(co2, temperature, humidity);
        if (readError == 0) {
          out.co2Ppm = co2;
          out.scdTempC = temperature;
          out.scdHumPct = humidity;
          haveScd = true;
          scdErrorCount_ = 0;
          lastScdDataMs_ = nowMs;
        } else {
          logScdError("readMeasurement", readError);
          registerSensorError();
        }
      }
    } else {
      // "Not ready" is normal right after a (re)start — the first measurement
      // lands ~5s later. But if an initialized SCD40 stays silent for 30s it is
      // stuck: some SCD4x clones halt periodic measurement on a bus glitch.
      // Force stopPeriodicMeasurement -> startPeriodicMeasurement via begin().
      if (nowMs - lastScdDataMs_ >= 30000UL) {
        Serial.println("[SCD40] No data for 30s — reinitializing");
        scdInitialized_ = false;
        scdErrorCount_ = 0;
      }
    }
  }

  bool haveSht = false;
  if (shtInitialized_) {
    sensors_event_t humidity, temp;
    if (sht4x.getEvent(&humidity, &temp)) {
      out.temperatureC = temp.temperature;
      out.humidityPct = humidity.relative_humidity;
      haveSht = true;
    }
  }

  bool haveDs = false;
  if (dsInitialized_) {
    ds18b20.requestTemperatures();
    float tempC = ds18b20.getTempCByIndex(0);
    if (tempC != DEVICE_DISCONNECTED_C) {
      out.compostTempC = tempC;
      haveDs = true;
    }
  }

  out.shtValid = haveSht;
  out.scdValid = haveScd;
  out.dsValid = haveDs;

  out.valid = (haveScd || haveSht || haveDs);
  
  if (out.valid) {
    errorCount_ = 0;
  }
  
  return out.valid;
}

bool SensorManager::isHealthy() const {
  return (scdInitialized_ || shtInitialized_ || dsInitialized_) && errorCount_ < 5;
}

uint32_t SensorManager::consecutiveErrors() const {
  return errorCount_;
}

// Standalone diagnostic script — checks whether the ESP32 is online and
// whether relay commands are being applied (reflected back in sensor
// payload's "r" array). Uses the same broker credentials as server/.env.
//
// Usage: RELAY_E2E=1 node mqtt-test.cjs
//
// THIS SENDS FAN_ON / FAN_OFF to real hardware. The RELAY_E2E guard exists
// because the filename matches Node's default test glob (**/*-test.?js), so a
// bare `node --test` from the repository root would otherwise pick it up and
// actuate the farm.
//
// NOTE: firmware only publishes fridge/sensors when:
//   - it's the very first reading since boot, OR
//   - a relay state changed, OR
//   - temp/hum/co2 changed by more than the delta threshold, OR
//   - HEARTBEAT_INTERVAL_MS (120s) has elapsed since last publish.
// So this script runs for ~150s to reliably catch at least one heartbeat,
// while also sending FAN_ON/FAN_OFF commands which should force an
// almost-immediate publish (relay state change bypasses delta/heartbeat).

require("dotenv").config();
const mqtt = require("mqtt");

if (process.env.RELAY_E2E !== "1") {
  console.error(
    "Refusing to run: this script sends real relay commands.\n" +
      "Re-run deliberately with:  RELAY_E2E=1 node mqtt-test.cjs",
  );
  // Exit 0, not 1: a skipped diagnostic is not a test failure.
  process.exit(0);
}

const url = process.env.MQTT_URL;
const username = process.env.MQTT_USERNAME;
const password = process.env.MQTT_PASSWORD;

if (!url) {
  console.error("MQTT_URL not set in .env — aborting.");
  process.exit(1);
}

console.log("== Mushroom Farm MQTT Diagnostic (long run ~150s) ==");
console.log("Broker:", url.replace(/\/\/.*@/, "//<hidden-creds>@"));

const client = mqtt.connect(url, { username, password, connectTimeout: 8000 });

let sensorCount = 0;
let statusHistory = [];
let sentFanOn = false;
let sentFanOff = false;
let fanStateAtOn = null;
let fanStateAfterOff = null;
let firstSensorAt = null;
let lastSensorAt = null;

function log(msg) {
  const t = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${t}] ${msg}`);
}

client.on("connect", () => {
  log("Connected to broker successfully.");
  client.subscribe("fridge/status", (err) => {
    if (err) log("ERROR subscribing fridge/status: " + err.message);
  });
  client.subscribe("fridge/sensors", (err) => {
    if (err) log("ERROR subscribing fridge/sensors: " + err.message);
  });
});

client.on("error", (err) => {
  log("MQTT ERROR: " + err.message);
});

client.on("message", (topic, message) => {
  const payload = message.toString();
  const now = Date.now();
  if (topic === "fridge/status") {
    statusHistory.push({ t: now, payload });
    log(`STATUS message: ${payload}`);
  } else if (topic === "fridge/sensors") {
    sensorCount++;
    if (!firstSensorAt) firstSensorAt = now;
    lastSensorAt = now;
    log(`SENSOR message #${sensorCount}: ${payload}`);
    try {
      const data = JSON.parse(payload);
      if (sentFanOn && Array.isArray(data.r) && fanStateAtOn === null) {
        fanStateAtOn = data.r[0];
      }
      if (sentFanOff && Array.isArray(data.r)) {
        fanStateAfterOff = data.r[0];
      }
    } catch (e) {
      log("Could not parse sensor JSON: " + e.message);
    }
  }
});

// Send FAN_ON at 5s
setTimeout(() => {
  log("Sending relay test command: FAN_ON (fridge/commands)");
  client.publish("fridge/commands", "FAN_ON");
  sentFanOn = true;
}, 5000);

// Send FAN_OFF at 20s (give 15s window to observe FAN_ON reflected)
setTimeout(() => {
  log("Sending relay test command: FAN_OFF (fridge/commands)");
  client.publish("fridge/commands", "FAN_OFF");
  sentFanOff = true;
}, 20000);

// Final report after 150s (covers heartbeat interval of 120s + buffer)
setTimeout(() => {
  console.log("\n== SUMMARY ==");
  console.log("Status messages seen:", JSON.stringify(statusHistory));
  console.log("Sensor messages received:", sensorCount);
  console.log("First sensor message at:", firstSensorAt ? new Date(firstSensorAt).toISOString() : "never");
  console.log("Last sensor message at:", lastSensorAt ? new Date(lastSensorAt).toISOString() : "never");
  console.log("Relay[0] (Fan) state right after FAN_ON:", fanStateAtOn ?? "unknown (no sensor update)");
  console.log("Relay[0] (Fan) state right after FAN_OFF:", fanStateAfterOff ?? "unknown (no sensor update)");

  const latestStatus = statusHistory.length ? statusHistory[statusHistory.length - 1].payload : null;

  if (sensorCount === 0) {
    console.log("\n>>> ESP32/CO2 sensor: NOT CONFIRMED WORKING.");
    console.log(">>> No fridge/sensors messages received in 150s (device would have to be dead silent,");
    console.log(">>> which shouldn't happen even with no CO2 change, because of the 120s heartbeat).");
    if (latestStatus === "online") {
      console.log(">>> fridge/status shows 'online' but this could be a STALE retained message from a");
      console.log(">>> previous session — MQTT retains the last status forever until a new one is published.");
    }
    console.log(">>> LIKELY CAUSES: ESP32 not powered on / crashed, WiFi not connecting, MQTT broker");
    console.log(">>> unreachable from device's network, or SCD40 sensor wiring/I2C failure blocking all publishes.");
  } else {
    console.log("\n>>> CO2/Temp/Humidity sensor: WORKING — live readings received from device.");
  }

  if (fanStateAtOn === 1 && fanStateAfterOff === 0) {
    console.log(">>> Relay control: WORKING — Fan relay toggled ON then OFF as commanded.");
  } else if (sensorCount === 0) {
    console.log(">>> Relay control: CANNOT CONFIRM (no data received at all).");
  } else {
    console.log(">>> Relay control: INCONCLUSIVE — did not observe expected ON->OFF toggle in the relay array.");
  }

  client.end(true, {}, () => process.exit(0));
}, 150000);

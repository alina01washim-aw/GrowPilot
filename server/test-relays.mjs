// Manual hardware bring-up script: cycles every relay ON then OFF over MQTT and
// prints the relay array the ESP reports back.
//
// Usage: RELAY_E2E=1 node test-relays.mjs
//
// THIS SWITCHES REAL HARDWARE, including the AC compressor, and it publishes
// straight to the broker — so the server's compressor guard does NOT apply. The
// cycle below holds each relay on for 8 seconds, which for a compressor is a
// short-cycle; run it deliberately, not casually.
//
// The RELAY_E2E guard exists because this filename matches Node's default test
// glob (**/test-*.?js). A bare `node --test` from the repository root picks it up
// and actuates the farm, which has already happened once.
import mqtt from "mqtt";

if (process.env.RELAY_E2E !== "1") {
  console.error(
    "Refusing to run: this script switches real relays (including the AC compressor)\n" +
      "and bypasses the server's compressor guard.\n" +
      "Re-run deliberately with:  RELAY_E2E=1 node test-relays.mjs",
  );
  process.exit(0);
}

// TODO: these belong in server/.env (MQTT_URL / MQTT_USERNAME / MQTT_PASSWORD)
// like every other entry point. Hardcoding them here puts live broker
// credentials in version control.
const BROKER_URL = process.env.MQTT_URL ?? "mqtt://75.119.133.7:1883";
const USERNAME = process.env.MQTT_USERNAME ?? "WRzhrAShevGFcn6g";
const PASSWORD = process.env.MQTT_PASSWORD ?? "FXUFBy1U9dUXzWQJm4uebwF95Ao18NLI";

const STATUS_TOPIC = "fridge/status";
const SENSOR_TOPIC = "fridge/sensors";
const COMMAND_TOPIC = "fridge/commands";

const COMMANDS = [
  { on: "FAN_ON", off: "FAN_OFF", label: "Relay 1 / IN1 G18 - Exhaust Fan" },
  { on: "AC_ON", off: "AC_OFF", label: "Relay 2 / IN2 G17 - AC Compressor" },
  { on: "MIST_ON", off: "MIST_OFF", label: "Relay 3 / IN3 G23 - Mist Maker" },
  { on: '{"r4":1}', off: '{"r4":0}', label: "Relay 4 / IN4 G5 - UV-C Light" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = mqtt.connect(BROKER_URL, {
  username: USERNAME,
  password: PASSWORD,
  reconnectPeriod: 3000,
});

let statusSeen = null;
let sensorCount = 0;
let lastRelayArray = null;

client.on("connect", async () => {
  console.log(`[MQTT] Connected to ${BROKER_URL}`);
  client.subscribe([STATUS_TOPIC, SENSOR_TOPIC, COMMAND_TOPIC], { qos: 1 });
  await sleep(1500);

  console.log("[MQTT] ESP32 status:", statusSeen ?? "(not received)");
  console.log("[MQTT] Initial relay array:", lastRelayArray);

  // Optional hardware self-test: each relay 2s ON in sequence. Set the env var
  // RELAY_TEST=1 to run it (watch the module LEDs + listen for clicks).
  if (process.env.RELAY_TEST === "1") {
    console.log("\n=== HARDWARE SELF-TEST (RELAY_TEST) ===");
    client.publish(COMMAND_TOPIC, "RELAY_TEST", { qos: 1 });
    await sleep(12000);
  }

  for (const { on, off, label } of COMMANDS) {
    console.log(`\n=== ${label} ===`);
    console.log(`[SEND] -> ${COMMAND_TOPIC}: ${on}`);
    client.publish(COMMAND_TOPIC, on, { qos: 1 });
    await sleep(8000);
    console.log(`[SEND] -> ${COMMAND_TOPIC}: ${off}`);
    client.publish(COMMAND_TOPIC, off, { qos: 1 });
    await sleep(4000);
  }

  console.log("\n[MQTT] Final relay array:", lastRelayArray);
  console.log("[MQTT] NOTE: r[0]=fan r[1]=AC r[2]=mist r[3]=UV");
  console.log("[MQTT] NOTE: server automation may re-engage mist if humidity < min");
  client.end(true);
});

client.on("message", (topic, message) => {
  const payload = message.toString();
  if (topic === STATUS_TOPIC) {
    statusSeen = payload;
    console.log(`[MQTT] ${topic} -> ${payload}`);
  } else if (topic === COMMAND_TOPIC) {
    if (payload.startsWith("{")) {
      console.log(`[MQTT] ${topic} -> ${payload}   <-- JSON command`);
    } else {
      console.log(`[MQTT] ${topic} -> ${payload}`);
    }
  } else if (topic === SENSOR_TOPIC) {
    sensorCount++;
    const m = payload.match(/r:\[([^\]]*)\]/);
    if (m) lastRelayArray = m[1];
    console.log(`[MQTT] ${topic} -> ${payload}`);
  }
});

client.on("error", (err) => console.error("[MQTT] error:", err.message));
client.on("offline", () => console.log("[MQTT] offline"));
client.on("close", () => console.log("[MQTT] disconnected"));
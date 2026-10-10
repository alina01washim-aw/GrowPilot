import mqtt, { type MqttClient } from "mqtt";
import { z } from "zod";
import { logger } from "./logger";
import { calculateVpd } from "./vpd";
import { ReadingModel } from "../models/reading";
import { RelayModel } from "../models/relay";
import { getSettings, publishThresholds } from "./settingsControl";
import {
  getDeviceConfigPayload,
  publishDeviceConfig,
} from "./profileControl";
import { publishAllRulePayloads } from "./ruleControl";
import { syncAutomationToSensors, scheduleRetryIfUnsettled } from "./automationSync";
import { setMqttClient } from "./mqttClientRef";

const SENSOR_TOPIC = "fridge/sensors";

// Default batch/sensor identity used to tag incoming readings. Integers are
// stored instead of repeating strings on every document.
const DEFAULT_SENSOR_ID = 101;
const DEFAULT_BATCH_ID = process.env["MUSHROOM_BATCH_ID"] ?? "BATCH_CURRENT";

// Sensor firmware sends compact keys (t/h/c) over the wire. Validated with
// Zod so a malformed/corrupt payload from a flaky sensor never propagates
// NaN/undefined into stored readings or automation decisions.
// t/h/c are optional: the firmware omits a parameter when its source sensor
// is offline (e.g. no SHT40 -> no t/h) instead of substituting another sensor.
const incomingPayloadSchema = z.object({
  t: z.number().finite().optional(),
  h: z.number().finite().min(0).max(100).optional(),
  c: z.number().finite().min(0).optional(),
  scdT: z.number().finite().optional(),
  scdH: z.number().finite().min(0).max(100).optional(),
  compT: z.number().finite().optional(),
  r: z.array(z.number().int().min(0).max(1)).length(4).optional(),
});

// The live client reference is kept in mqttClientRef.ts (a dependency-free
// module) so settingsControl.ts can import it without creating a cycle.
let client: MqttClient | null = null;

// Process sensor messages one at a time so concurrent automation runs cannot
// race each other when toggling relays.
let messageChain: Promise<void> = Promise.resolve();

async function handleMessage(topic: string, message: Buffer) {
  if (topic !== SENSOR_TOPIC) return;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(message.toString());
    logger.info({ parsedJson }, "Received raw MQTT message");
  } catch (err) {
    logger.error({ err }, "Failed to parse MQTT sensor payload");
    return;
  }

  const result = incomingPayloadSchema.safeParse(parsedJson);
  if (!result.success) {
    logger.error(
      { issues: result.error.issues },
      "Rejected malformed MQTT sensor payload",
    );
    return;
  }
  const data = result.data;

  // Missing SHT40 values must stay missing — never substitute SCD40's
  // temperature/humidity into the SHT40 slot (they are different sensors).

  let vpd: number | null = null;
  if (data.t != null && data.h != null) {
    try {
      vpd = calculateVpd(data.t, data.h);
    } catch (err) {
      logger.error(
        { temp: data.t, humidity: data.h, err },
        "VPD calculation failed - rejecting sensor reading",
      );
      return;
    }
  }

  try {
    const relayDocs = await RelayModel.find(
      { name: { $in: ["fan", "fridge", "humidifier"] } },
      { name: 1, state: 1 },
    ).lean();

    const relaySnapshot = {
      fan: relayDocs.find((r) => r.name === "fan")?.state ?? false,
      fridge: relayDocs.find((r) => r.name === "fridge")?.state ?? false,
      humidifier:
        relayDocs.find((r) => r.name === "humidifier")?.state ?? false,
    };

    await ReadingModel.create({
      timestamp: new Date(),
      sensorId: DEFAULT_SENSOR_ID,
      batchId: DEFAULT_BATCH_ID,
      temp: data.t,
      hum: data.h,
      co2: data.c,
      scdTemp: data.scdT,
      scdHum: data.scdH,
      compostTemp: data.compT,
      vpd,
      relays: relaySnapshot,
    });

    if (data.r != null && data.r.length === 4) {
      const relayNames = ["fan", "fridge", "humidifier"] as const;
      const updates = relayNames.map((name, i) =>
        RelayModel.updateOne(
          { name },
          {
            $set: {
              state: data.r![i] === 1,
              updatedAt: new Date(),
              source: "auto",
            },
          },
          { upsert: false },
        ),
      );
      await Promise.all(updates);

      // Update UV relay state in DeviceProfile relayMap (no RelayModel doc for uv)
      if (data.r != null && data.r[3] != null) {
        const { DeviceProfileModel } = await import("../models/deviceProfile");
        await DeviceProfileModel.updateOne(
          { profileId: "main", "relayMap.key": "uv" },
          { $set: { "relayMap.$.state": data.r[3] === 1 } },
        ).lean();
      }
    }
  } catch (err) {
    // The automation below reads the newest *stored* reading, so if this write
    // failed there is nothing fresh to act on — acting would apply the previous
    // reading a second time. Skip this message; the next one is 2 minutes away.
    logger.error({ err }, "Failed to persist sensor reading — skipping automation pass");
    return;
  }

  // One decision path for the whole system: the rules (latched, stage-scoped),
  // then the threshold bands as a fallback, applied through applyDeviceState so
  // device modes, crop-stage parking and the compressor guard all hold. "sensor"
  // runs in edge mode, matching how the firmware writes relays only on a rule's
  // latch transition.
  const report = await syncAutomationToSensors("sensor");
  scheduleRetryIfUnsettled(report);
}

/**
 * Connects to the MQTT broker and wires up sensor ingestion + automation.
 * Safe to call once at server startup. Connection errors are logged but do
 * not crash the server -- the dashboard/API remain usable even if the
 * broker is temporarily unreachable.
 */
export function startMqttClient(): MqttClient | null {
  const url = process.env["MQTT_URL"];
  const username = process.env["MQTT_USERNAME"];
  const password = process.env["MQTT_PASSWORD"];

  if (!url) {
    logger.warn("MQTT_URL not set -- skipping MQTT connection");
    return null;
  }

  client = mqtt.connect(url, { username, password, reconnectPeriod: 5000 });
  setMqttClient(client);

  client.on("connect", () => {
    // Never log the raw broker URL: MQTT_URL can embed credentials
    // (mqtt://user:pass@host:port), and pino would otherwise persist them.
    logger.info({ host: safeHost(url) }, "Connected to MQTT broker");

    // Re-publish retained thresholds + device profile so a freshly booted or
    // reconnecting ESP32 gets the latest config right away, even when the
    // backend was offline at the time the user last saved settings.
    void getSettings().then(publishThresholds);
    void getDeviceConfigPayload().then(publishDeviceConfig);
    // Re-publish the dynamic rule set so a freshly booted / reconnecting ESP32
    // gets the latest edge-executed rules immediately.
    void publishAllRulePayloads();

    client?.subscribe(SENSOR_TOPIC, (err) => {
      if (err) {
        logger.error({ err }, "Failed to subscribe to sensor topic");
      } else {
        logger.info({ topic: SENSOR_TOPIC }, "Subscribed to sensor topic");
      }
    });
  });

  client.on("message", (topic, message) => {
    messageChain = messageChain
      .then(() => handleMessage(topic, message))
      .catch((err) => {
        logger.error({ err }, "Unhandled error in MQTT message handler");
      });
  });

  client.on("error", (err) => {
    logger.error({ err }, "MQTT client error");
  });

  client.on("reconnect", () => {
    logger.warn("MQTT client reconnecting to broker...");
  });

  client.on("offline", () => {
    logger.warn("MQTT client is offline");
  });

  return client;
}

function safeHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
  } catch {
    return "unknown";
  }
}

import { SettingsModel, type SettingsDocument } from "../models/settings";
import { getMqttClient } from "./mqttClientRef";
import { logger } from "./logger";

const DEVICE_CONFIG_TOPIC = "fridge/device-config";

/**
 * Dashboard-facing view of the device profile. Passwords are never echoed
 * back — the client only learns whether one is currently set so it can render
 * a masked placeholder.
 */
export interface ProfileView {
  deviceName: string;
  wifiSsid: string;
  hasWifiPassword: boolean;
  backupWifiSsid: string;
  hasBackupWifiPassword: boolean;
  mqttHost: string;
  mqttPort: number;
  mqttUsername: string;
  hasMqttPassword: boolean;
  updatedAt: Date;
}

/** Full stored profile incl. secrets — used only server-side (publishing to ESP32). */
export interface DeviceConfigPayload {
  deviceName: string;
  wifiSsid: string;
  wifiPassword: string;
  backupWifiSsid: string;
  backupWifiPassword: string;
  mqttHost: string;
  mqttPort: number;
  mqttUsername: string;
  mqttPassword: string;
}

type ProfileDoc = SettingsDocument & {
  deviceName?: string;
  wifiSsid?: string;
  wifiPassword?: string;
  backupWifiSsid?: string;
  backupWifiPassword?: string;
  mqttHost?: string;
  mqttPort?: number;
  mqttUsername?: string;
  mqttPassword?: string;
};

function toView(doc: ProfileDoc): ProfileView {
  return {
    deviceName:          doc.deviceName ?? "Mushking IoT",
    wifiSsid:            doc.wifiSsid ?? "",
    hasWifiPassword:     Boolean(doc.wifiPassword),
    backupWifiSsid:      doc.backupWifiSsid ?? "",
    hasBackupWifiPassword: Boolean(doc.backupWifiPassword),
    mqttHost:            doc.mqttHost ?? "",
    mqttPort:            doc.mqttPort ?? 1883,
    mqttUsername:        doc.mqttUsername ?? "",
    hasMqttPassword:     Boolean(doc.mqttPassword),
    updatedAt:           (doc as SettingsDocument & { updatedAt: Date }).updatedAt,
  };
}

function toPayload(doc: ProfileDoc): DeviceConfigPayload {
  return {
    deviceName:          doc.deviceName ?? "Mushking IoT",
    wifiSsid:            doc.wifiSsid ?? "",
    wifiPassword:        doc.wifiPassword ?? "",
    backupWifiSsid:      doc.backupWifiSsid ?? "",
    backupWifiPassword:  doc.backupWifiPassword ?? "",
    mqttHost:            doc.mqttHost ?? "",
    mqttPort:            doc.mqttPort ?? 1883,
    mqttUsername:        doc.mqttUsername ?? "",
    mqttPassword:        doc.mqttPassword ?? "",
  };
}

const DEFAULTS: DeviceConfigPayload = {
  deviceName: "Mushking IoT",
  wifiSsid: "",
  wifiPassword: "",
  backupWifiSsid: "",
  backupWifiPassword: "",
  mqttHost: "",
  mqttPort: 1883,
  mqttUsername: "",
  mqttPassword: "",
};

/**
 * Reads the singleton profile doc, upserting default fields on first boot so
 * older docs transparently gain the new keys.
 */
export async function getProfile(): Promise<ProfileView> {
  const doc = await SettingsModel.findByIdAndUpdate(
    "default",
    [
      {
        $set: {
          deviceName:          { $ifNull: ["$deviceName",          DEFAULTS.deviceName] },
          wifiSsid:            { $ifNull: ["$wifiSsid",            DEFAULTS.wifiSsid] },
          wifiPassword:        { $ifNull: ["$wifiPassword",        DEFAULTS.wifiPassword] },
          backupWifiSsid:      { $ifNull: ["$backupWifiSsid",      DEFAULTS.backupWifiSsid] },
          backupWifiPassword:  { $ifNull: ["$backupWifiPassword",  DEFAULTS.backupWifiPassword] },
          mqttHost:            { $ifNull: ["$mqttHost",            DEFAULTS.mqttHost] },
          mqttPort:            { $ifNull: ["$mqttPort",            DEFAULTS.mqttPort] },
          mqttUsername:        { $ifNull: ["$mqttUsername",        DEFAULTS.mqttUsername] },
          mqttPassword:        { $ifNull: ["$mqttPassword",        DEFAULTS.mqttPassword] },
          updatedAt:           { $ifNull: ["$updatedAt",           new Date()] },
        },
      },
    ],
    { upsert: true, new: true },
  ).lean();

  return toView(doc as unknown as ProfileDoc);
}

export type ProfilePatch = {
  deviceName?: string;
  wifiSsid?: string;
  wifiPassword?: string;
  backupWifiSsid?: string;
  backupWifiPassword?: string;
  mqttHost?: string;
  mqttPort?: number;
  mqttUsername?: string;
  mqttPassword?: string;
};

/**
 * Partial-updates the device profile, persists it, then publishes the full
 * config (including secrets) to ESP32 via a *retained* MQTT message so the
 * device always receives the latest profile on reconnect/boot.
 */
export async function updateProfile(patch: ProfilePatch): Promise<ProfileView> {
  const $set: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of [
    "deviceName",
    "wifiSsid",
    "wifiPassword",
    "backupWifiSsid",
    "backupWifiPassword",
    "mqttHost",
    "mqttPort",
    "mqttUsername",
    "mqttPassword",
  ] as const) {
    if (patch[key] !== undefined && patch[key] !== null) {
      // Trim cosmetic string fields; keep passwords verbatim (they may contain
      // any characters, and the client sends "" to clear one).
      if (typeof patch[key] === "string" && key !== "wifiPassword" && key !== "backupWifiPassword" && key !== "mqttPassword") {
        $set[key] = (patch[key] as string).trim();
      } else {
        $set[key] = patch[key];
      }
    }
  }

  const doc = await SettingsModel.findByIdAndUpdate(
    "default",
    { $set, $setOnInsert: { _id: "default" } },
    { upsert: true, new: true },
  ).lean();

  publishDeviceConfig(toPayload(doc as unknown as ProfileDoc));
  return toView(doc as unknown as ProfileDoc);
}

/** Publishes the full device profile to ESP32 with retain=true (topic: fridge/device-config). */
export function publishDeviceConfig(profile: DeviceConfigPayload): void {
  const mqttClient = getMqttClient();
  if (!mqttClient) return;

  const payload = JSON.stringify(profile);
  mqttClient.publish(DEVICE_CONFIG_TOPIC, payload, { retain: true }, (err) => {
    if (err) {
      logger.error({ err }, "Failed to publish device config to MQTT");
    } else {
      logger.info({ topic: DEVICE_CONFIG_TOPIC }, "Device config published (retained)");
    }
  });
}

/** loads the full payload (with secrets) directly from Mongo — used at MQTT connect. */
export async function getDeviceConfigPayload(): Promise<DeviceConfigPayload> {
  const doc = await SettingsModel.findById("default").lean();
  return toPayload((doc ?? {}) as ProfileDoc);
}
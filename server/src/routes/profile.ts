import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  getProfile,
  updateProfile,
  type ProfilePatch,
} from "../lib/profileControl";

const router: IRouter = Router();

const UpdateProfileBodySchema = z
  .object({
    deviceName: z.string().min(1, "Device name cannot be empty").max(64).optional(),
    wifiSsid: z.string().min(1, "WiFi SSID cannot be empty").max(64).optional(),
    wifiPassword: z.string().max(64).optional(),
    backupWifiSsid: z.string().max(64).optional(),
    backupWifiPassword: z.string().max(64).optional(),
    mqttHost: z.string().max(255).optional(),
    mqttPort: z.number().int().min(1).max(65535).optional(),
    mqttUsername: z.string().max(128).optional(),
    mqttPassword: z.string().max(128).optional(),
  })
  .strict();

function serializeProfile(p: {
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
}) {
  return {
    deviceName: p.deviceName,
    wifiSsid: p.wifiSsid,
    hasWifiPassword: p.hasWifiPassword,
    backupWifiSsid: p.backupWifiSsid,
    hasBackupWifiPassword: p.hasBackupWifiPassword,
    mqttHost: p.mqttHost,
    mqttPort: p.mqttPort,
    mqttUsername: p.mqttUsername,
    hasMqttPassword: p.hasMqttPassword,
    updatedAt: p.updatedAt.toISOString(),
  };
}

router.get("/profile", async (_req, res): Promise<void> => {
  const profile = await getProfile();
  res.json(serializeProfile(profile));
});

router.patch("/profile", async (req, res): Promise<void> => {
  const body = UpdateProfileBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid profile payload" });
    return;
  }

  try {
    const profile = await updateProfile(body.data as ProfilePatch);
    res.json(serializeProfile(profile));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Failed to update profile" });
  }
});

export default router;
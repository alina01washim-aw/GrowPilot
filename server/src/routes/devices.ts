import { Router, type IRouter } from "express";
import {
  isRuleDeviceKey,
  listDeviceControls,
  setDeviceMode,
  setDeviceState,
  renameDevice,
  RelayGuardedError,
  DeviceRenameError,
} from "../lib/deviceControl";
import { DEVICE_ICON_IDS } from "../models/deviceProfile";

const router: IRouter = Router();

const DEVICE_KEYS = ["fan", "ac", "mist_maker", "uv"] as const;

// List all controllable devices (from the relay registry) with their
// AUTO/MANUAL mode and current state.
router.get("/devices/control", async (_req, res): Promise<void> => {
  const devices = await listDeviceControls();
  res.json(devices);
});

// The icon set a device may be displayed with.
router.get("/devices/icons", (_req, res): void => {
  res.json({ icons: DEVICE_ICON_IDS });
});

// Rename a device / change its icon. The key is intentionally immutable — rules,
// crop stage plans and runtime history all reference it.
router.patch("/devices/:key", async (req, res): Promise<void> => {
  const raw = String(req.params.key);
  if (!(DEVICE_KEYS as readonly string[]).includes(raw) || !isRuleDeviceKey(raw)) {
    res.status(400).json({ error: `Unknown device key: ${raw}` });
    return;
  }

  const { label, icon } = req.body ?? {};
  if (label === undefined && icon === undefined) {
    res.status(400).json({ error: "Provide a label and/or an icon" });
    return;
  }
  if (label !== undefined && typeof label !== "string") {
    res.status(400).json({ error: "label must be a string" });
    return;
  }
  if (icon !== undefined && typeof icon !== "string") {
    res.status(400).json({ error: "icon must be a string" });
    return;
  }

  try {
    const device = await renameDevice(raw, { label, icon });
    res.json(device);
  } catch (err) {
    if (err instanceof DeviceRenameError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof Error && err.message === "unknown-device") {
      res.status(404).json({ error: "Device not found in profile" });
      return;
    }
    throw err;
  }
});

// Switch a device between AUTO (rules) and MANUAL (user) mode.
router.post("/devices/:key/mode", async (req, res): Promise<void> => {
  const raw = String(req.params.key);
  if (!(DEVICE_KEYS as readonly string[]).includes(raw) || !isRuleDeviceKey(raw)) {
    res.status(400).json({ error: `Unknown device key: ${raw}` });
    return;
  }
  const mode = req.body?.mode;
  if (mode !== "auto" && mode !== "manual") {
    res.status(400).json({ error: "mode must be \"auto\" or \"manual\"" });
    return;
  }

  try {
    const device = await setDeviceMode(raw, mode);
    res.json(device);
  } catch (err) {
    if (err instanceof Error && err.message === "unknown-device") {
      res.status(404).json({ error: "Device not found in profile" });
      return;
    }
    throw err;
  }
});

// Manual on/off command (only effective in MANUAL mode).
router.post("/devices/:key/state", async (req, res): Promise<void> => {
  const raw = String(req.params.key);
  if (!(DEVICE_KEYS as readonly string[]).includes(raw) || !isRuleDeviceKey(raw)) {
    res.status(400).json({ error: `Unknown device key: ${raw}` });
    return;
  }
  if (typeof req.body?.on !== "boolean") {
    res.status(400).json({ error: "on must be a boolean" });
    return;
  }

  try {
    const device = await setDeviceState(raw, req.body.on);
    res.json(device);
  } catch (err) {
    if (err instanceof RelayGuardedError) {
      res.status(400).json({
        error: err.message,
        guardedUntil: err.guardedUntil.toISOString(),
      });
      return;
    }
    throw err;
  }
});

export default router;
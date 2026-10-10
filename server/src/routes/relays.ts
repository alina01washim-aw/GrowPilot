import { Router, type IRouter } from "express";
import {
  ListRelaysResponse,
  SetRelayStateBody,
  SetRelayStateResponse,
} from "../lib/api-zod";
import {
  ensureRelaysInitialized,
  isRelayName,
  listRelays,
  setRelayState,
  RelayGuardedError,
} from "../lib/relayControl";
import { publishRelayCommand } from "../lib/mqttCommands";
import { publishAllRulePayloads } from "../lib/ruleControl";

const router: IRouter = Router();

function serializeRelay(relay: {
  name: string;
  state: boolean;
  updatedAt: Date;
  guardedUntil: Date | null;
  source: string;
  automationEnabled: boolean;
}) {
  return {
    name: relay.name as "fan" | "fridge" | "humidifier",
    state: relay.state,
    updatedAt: relay.updatedAt.toISOString(),
    guardedUntil: relay.guardedUntil ? relay.guardedUntil.toISOString() : null,
    source: relay.source as "manual" | "auto",
    automationEnabled: relay.automationEnabled,
  };
}

router.get("/relays", async (_req, res): Promise<void> => {
  await ensureRelaysInitialized();
  const relays = await listRelays();
  res.json(ListRelaysResponse.parse(relays.map(serializeRelay)));
});

router.patch("/relays/:name", async (req, res): Promise<void> => {
  const raw = req.params.name;

  if (!raw || !isRelayName(raw)) {
    res.status(400).json({ error: `Unknown relay name: ${String(raw)}` });
    return;
  }

  const body = SetRelayStateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  try {
    const relay = await setRelayState(raw, body.data.state, "manual");
    publishRelayCommand(raw, relay.state);
    res.json(SetRelayStateResponse.parse(serializeRelay(relay)));
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

// Stop automation for a specific relay
router.post(
  "/relays/:name/stop-automation",
  async (req, res): Promise<void> => {
    const raw = req.params.name;

    if (!raw || !isRelayName(raw)) {
      res.status(400).json({ error: `Unknown relay name: ${String(raw)}` });
      return;
    }

    try {
      // Turn OFF the relay
      const relay = await setRelayState(raw, false, "manual");
      publishRelayCommand(raw, false);

      // Disable automation for this relay
      const { RelayModel } = await import("../models/relay");
      const updated = await RelayModel.findOneAndUpdate(
        { name: raw },
        { $set: { automationEnabled: false, updatedAt: new Date() } },
        { new: true },
      ).lean();

      if (!updated) {
        res.status(404).json({ error: "Relay not found" });
        return;
      }

      res.json({
        ok: true,
        relay: serializeRelay({
          name: updated.name,
          state: updated.state,
          updatedAt: updated.updatedAt,
          guardedUntil: updated.guardedUntil ?? null,
          source: updated.source ?? "manual",
          automationEnabled: updated.automationEnabled ?? false,
        }),
        message: `Automation stopped for ${raw}`,
      });
    } catch (err) {
      throw err;
    } finally {
      // Keep the ESP edge engine's device registry in sync with the mode.
      void publishAllRulePayloads().catch(() => undefined);
    }
  },
);

// Activate automation for a specific relay
router.post(
  "/relays/:name/activate-automation",
  async (req, res): Promise<void> => {
    const raw = req.params.name;

    if (!raw || !isRelayName(raw)) {
      res.status(400).json({ error: `Unknown relay name: ${String(raw)}` });
      return;
    }

    try {
      // Enable automation for this relay
      const { RelayModel } = await import("../models/relay");
      const updated = await RelayModel.findOneAndUpdate(
        { name: raw },
        { $set: { automationEnabled: true, updatedAt: new Date() } },
        { new: true },
      ).lean();

      if (!updated) {
        res.status(404).json({ error: "Relay not found" });
        return;
      }

      res.json({
        ok: true,
        relay: serializeRelay({
          name: updated.name,
          state: updated.state,
          updatedAt: updated.updatedAt,
          guardedUntil: updated.guardedUntil ?? null,
          source: updated.source ?? "manual",
          automationEnabled: updated.automationEnabled ?? true,
        }),
        message: `Automation activated for ${raw}`,
      });
    } catch (err) {
      throw err;
    } finally {
      void publishAllRulePayloads().catch(() => undefined);
    }
  },
);

export default router;

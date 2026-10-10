import "dotenv/config";

import type { Server } from "node:http";
import mongoose from "mongoose";
import app from "./app";
import { logger } from "./lib/logger";
import { connectMongo } from "./lib/mongo";
import { ensureRelaysInitialized } from "./lib/relayControl";
import {
  backfillDeviceHistoryFromRelays,
  ensureDeviceStateHistoryInitialized,
} from "./lib/deviceStateHistory";
import { startMqttClient } from "./lib/mqttClient";
import { cancelAutomationRetry } from "./lib/automationSync";
import { startCropCycleScheduler, stopCropCycleScheduler } from "./lib/cropCycle";
import { startRiskMonitor, stopRiskMonitor } from "./lib/riskMonitor";
import { getMqttClient, setMqttClient } from "./lib/mqttClientRef";
import { attachAiSocket } from "./lib/aiSocket";
import { attachVoiceSocket } from "./lib/voiceSocket";
import { attachRealtimeSocket } from "./lib/realtimeSocket";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

let server: Server | null = null;
let shuttingDown = false;

async function bootstrap(): Promise<void> {
  await connectMongo();
  await ensureRelaysInitialized();
  await ensureDeviceStateHistoryInitialized();
  await backfillDeviceHistoryFromRelays();
  startMqttClient();
  startCropCycleScheduler();
  startRiskMonitor();

  server = app.listen(port, () => {
    logger.info({ port }, "Server listening");
  });

  // WebSocket endpoints: AI chat + live voice call channel.
  attachAiSocket(server);
  attachVoiceSocket(server);
  attachRealtimeSocket(server);

  server.on("error", (err) => {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  });
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "Shutting down");

  cancelAutomationRetry();
  stopCropCycleScheduler();
  stopRiskMonitor();

  const mqttClient = getMqttClient();
  if (mqttClient) {
    await new Promise<void>((resolve) => {
      mqttClient.end(false, {}, () => resolve());
    });
    setMqttClient(null);
  }

  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()));
    });
  }

  await mongoose.disconnect();
  logger.info("Shutdown complete");
  process.exit(0);
}

bootstrap().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

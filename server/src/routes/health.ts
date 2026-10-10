import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "../lib/api-zod";
import { getMqttClient } from "../lib/mqttClientRef";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const client = getMqttClient();
  const mqttStatus = client?.connected ? "connected" : "disconnected";

  const data = HealthCheckResponse.parse({ status: "ok", mqtt: mqttStatus });
  res.json(data);
});

export default router;

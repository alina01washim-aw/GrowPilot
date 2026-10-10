import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import readingsRouter from "./readings";
import relaysRouter from "./relays";
import settingsRouter from "./settings";
import systemRouter from "./system";
import profileRouter from "./profile";
import automationRulesRouter from "./automationRules";
import devicesRouter from "./devices";
import deviceHistoryRouter from "./deviceHistory";
import cropCycleRouter from "./cropCycle";
import annotationsRouter from "./annotations";
import riskRouter from "./risk";
import aiRouter from "./ai";
import voiceRouter from "./voice";
import realtimeRouter from "./realtime";
import vpdRouter from "./vpd";
import { requireAuth } from "../middleware/requireAuth";

const router: IRouter = Router();

// Public routes: health check and login do not require a token.
router.use(healthRouter);
router.use(authRouter);

// Everything else (sensor readings, relay control) requires a valid JWT.
router.use(requireAuth);
router.use(readingsRouter);
router.use(relaysRouter);
router.use(settingsRouter);
router.use(systemRouter);
router.use(profileRouter);
router.use(automationRulesRouter);
router.use(devicesRouter);
router.use(deviceHistoryRouter);
router.use(cropCycleRouter);
router.use(annotationsRouter);
router.use(riskRouter);
router.use(aiRouter);
router.use(voiceRouter);
router.use(realtimeRouter);
router.use(vpdRouter);

export default router;

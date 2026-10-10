import { Router, type IRouter, type Response } from "express";
import {
  createRule,
  deleteRule,
  getRule,
  listRules,
  updateRule,
} from "../lib/ruleControl";
import { formatRuleError } from "../lib/ruleSchemas";

const router: IRouter = Router();

function respondWithError(res: Response, err: unknown): void {
  if (err instanceof Error) {
    res.status(400).json({ error: formatRuleError(err) });
    return;
  }
  res.status(400).json({ error: "Invalid rule" });
}

// List all automation rules
router.get("/rules", async (_req, res): Promise<void> => {
  const rules = await listRules();
  res.json(rules);
});

// Fetch a single rule
router.get("/rules/:id", async (req, res): Promise<void> => {
  const rule = await getRule(String(req.params.id));
  if (!rule) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }
  res.json(rule);
});

// Create a rule
router.post("/rules", async (req, res): Promise<void> => {
  try {
    const rule = await createRule(req.body);
    res.status(201).json(rule);
  } catch (err) {
    if (err instanceof Error && err.message !== "rule-not-found") {
      respondWithError(res, err);
      return;
    }
    throw err;
  }
});

// Update a rule
router.patch("/rules/:id", async (req, res): Promise<void> => {
  try {
    const rule = await updateRule(String(req.params.id), req.body);
    res.json(rule);
  } catch (err) {
    if (err instanceof Error && err.message === "rule-not-found") {
      res.status(404).json({ error: "Rule not found" });
      return;
    }
    if (err instanceof Error) {
      respondWithError(res, err);
      return;
    }
    throw err;
  }
});

// Delete a rule
router.delete("/rules/:id", async (req, res): Promise<void> => {
  try {
    await deleteRule(String(req.params.id));
    res.status(204).end();
  } catch (err) {
    if (err instanceof Error && err.message === "rule-not-found") {
      res.status(404).json({ error: "Rule not found" });
      return;
    }
    throw err;
  }
});

export default router;
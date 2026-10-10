import { Router, type IRouter } from "express";
import { LoginBody, LoginResponse } from "../lib/api-zod";
import { signToken, verifyCredentials } from "../lib/auth";

const router: IRouter = Router();

router.post("/auth/login", async (req, res): Promise<void> => {
  const body = LoginBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const valid = await verifyCredentials(body.data.username, body.data.password);
  if (!valid) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  const token = signToken(body.data.username);
  res.json(LoginResponse.parse({ token }));
});

export default router;

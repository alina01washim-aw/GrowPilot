import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "../lib/auth";

/**
 * Protects a route with a Bearer JWT check. Rejects with 401 when the
 * Authorization header is missing, malformed, or carries an invalid/expired
 * token.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;

  if (!token) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  try {
    verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

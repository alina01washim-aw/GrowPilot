import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env["JWT_SECRET"];
const ADMIN_USERNAME = process.env["ADMIN_USERNAME"];
const ADMIN_PASSWORD = process.env["ADMIN_PASSWORD"];

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is required but was not provided.");
}
if (!ADMIN_USERNAME) {
  throw new Error("ADMIN_USERNAME environment variable is required but was not provided.");
}
if (!ADMIN_PASSWORD) {
  throw new Error("ADMIN_PASSWORD environment variable is required but was not provided.");
}

// Re-bind as definitely-typed strings so TypeScript's control-flow narrowing
// above (which only applies within this block) carries through to the
// functions declared below in this module.
const jwtSecret: string = JWT_SECRET;
const adminUsername: string = ADMIN_USERNAME;

// Hash the configured admin password once at boot (never store/compare
// plaintext) so credential checks always go through bcrypt, even though the
// source of truth is a plain env secret.
const adminPasswordHash = bcrypt.hashSync(ADMIN_PASSWORD, 12);

const TOKEN_TTL = "30d";

export interface AuthTokenPayload {
  sub: string;
}

export async function verifyCredentials(
  username: string,
  password: string,
): Promise<boolean> {
  if (username !== adminUsername) {
    // Still run a bcrypt compare against the real hash so that invalid
    // usernames and invalid passwords take the same amount of time,
    // avoiding a username-enumeration timing side-channel.
    await bcrypt.compare(password, adminPasswordHash);
    return false;
  }

  return bcrypt.compare(password, adminPasswordHash);
}

export function signToken(username: string): string {
  return jwt.sign({ sub: username } satisfies AuthTokenPayload, jwtSecret, {
    expiresIn: TOKEN_TTL,
  });
}

export function verifyToken(token: string): AuthTokenPayload {
  return jwt.verify(token, jwtSecret) as AuthTokenPayload;
}

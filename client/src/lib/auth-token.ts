// The `mycocontrol.` prefix predates the rename to Mushking IoT and is kept on
// purpose: these are live localStorage keys, so renaming them would sign every
// existing user out for no benefit. Changing them needs a read-old/write-new
// migration, not a find-and-replace.
export const TOKEN_STORAGE_KEY = "mycocontrol.token";
export const USERNAME_STORAGE_KEY = "mycocontrol.username";

/** Decode JWT expiry without verifying signature (client-side UX only). */
export function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return true;

    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: number };

    if (typeof payload.exp !== "number") return false;

    // Refresh slightly before expiry so we don't flap between screens.
    return Date.now() >= payload.exp * 1000 - 30_000;
  } catch {
    return true;
  }
}

export function getStoredToken(): string | null {
  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!token) return null;

  if (isTokenExpired(token)) {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    return null;
  }

  return token;
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function getStoredUsername(): string {
  return localStorage.getItem(USERNAME_STORAGE_KEY) ?? "";
}

export function storeUsername(username: string): void {
  localStorage.setItem(USERNAME_STORAGE_KEY, username);
}

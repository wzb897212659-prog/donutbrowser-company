import { createHash, randomBytes } from "node:crypto";
import * as argon2 from "argon2";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function validatePassword(password: string): string | null {
  if (password.length < 12) return "PASSWORD_TOO_SHORT";
  if (password.length > 256) return "PASSWORD_TOO_LONG";
  return null;
}

export function validateUsername(username: string): boolean {
  return /^[A-Za-z0-9_.-]{3,64}$/.test(username);
}

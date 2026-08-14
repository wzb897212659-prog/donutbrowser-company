import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { AuthService } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { Database } from "./db.js";
import { ProfileService } from "./profile-service.js";
import type { AuthUser } from "./types.js";

const SUPER_ADMIN: AuthUser = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "root",
  role: "super_admin",
  tokenVersion: 1,
};
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_IDS = [
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];

test("batch transfer replaces assignments and owner atomically", async () => {
  const queries: string[] = [];
  const audits: Array<{ action: string; target?: string }> = [];
  const client = {
    async query(text: string) {
      queries.push(text);
      if (text.includes("SELECT id FROM users"))
        return { rows: [{ id: ADMIN_ID }] };
      if (text.includes("SELECT id FROM profiles")) {
        return { rows: PROFILE_IDS.map((id) => ({ id })) };
      }
      if (text.includes("SELECT profile_id::text")) return { rows: [] };
      return { rows: [], rowCount: 1 };
    },
  };
  const db = {
    transaction: async <T>(fn: (value: PoolClient) => Promise<T>) =>
      fn(client as unknown as PoolClient),
  } as unknown as Database;
  const auth = {
    audit: async (
      _actor: string,
      action: string,
      _profile?: string,
      target?: string,
    ) => {
      audits.push({ action, target });
    },
  } as unknown as AuthService;

  const result = await new ProfileService(db, auth).batchTransfer(
    SUPER_ADMIN,
    PROFILE_IDS,
    ADMIN_ID,
  );

  assert.equal(result.status, 200);
  assert.ok(
    queries.some((query) => query.includes("UPDATE profiles SET owner_id")),
  );
  assert.ok(
    queries.some((query) => query.includes("DELETE FROM profile_assignments")),
  );
  assert.ok(
    queries.some((query) => query.includes("INSERT INTO profile_assignments")),
  );
  assert.deepEqual(audits, [
    { action: "profile.assignments.batch_transfer", target: ADMIN_ID },
  ]);
});

test("batch transfer rejects the entire batch when any profile is leased", async () => {
  const queries: string[] = [];
  const client = {
    async query(text: string) {
      queries.push(text);
      if (text.includes("SELECT id FROM users"))
        return { rows: [{ id: ADMIN_ID }] };
      if (text.includes("SELECT id FROM profiles")) {
        return { rows: PROFILE_IDS.map((id) => ({ id })) };
      }
      if (text.includes("SELECT profile_id::text")) {
        return { rows: [{ id: PROFILE_IDS[0] }] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const db = {
    transaction: async <T>(fn: (value: PoolClient) => Promise<T>) =>
      fn(client as unknown as PoolClient),
  } as unknown as Database;
  const auth = { audit: async () => undefined } as unknown as AuthService;

  const result = await new ProfileService(db, auth).batchTransfer(
    SUPER_ADMIN,
    PROFILE_IDS,
    ADMIN_ID,
  );

  assert.equal(result.status, 409);
  assert.equal(result.success, false);
  assert.ok(
    !queries.some((query) => query.includes("UPDATE profiles SET owner_id")),
  );
  assert.ok(
    !queries.some((query) => query.includes("DELETE FROM profile_assignments")),
  );
});

test("normal administrators cannot batch transfer profiles", async () => {
  const db = {
    transaction: async () => {
      throw new Error("transaction must not be reached");
    },
  } as unknown as Database;
  const auth = { audit: async () => undefined } as unknown as AuthService;
  const normalAdmin: AuthUser = { ...SUPER_ADMIN, role: "admin" };

  const result = await new ProfileService(db, auth).batchTransfer(
    normalAdmin,
    PROFILE_IDS,
    ADMIN_ID,
  );

  assert.deepEqual(result, { status: 403, success: false, code: "FORBIDDEN" });
});

test("password reset changes the hash, clears lockout, and revokes refresh tokens", async () => {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      if (text.includes("SELECT id, role FROM users")) {
        return { rows: [{ id: ADMIN_ID, role: "admin" }] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const db = {
    transaction: async <T>(fn: (value: PoolClient) => Promise<T>) =>
      fn(client as unknown as PoolClient),
  } as unknown as Database;
  const config = {} as AppConfig;
  const password = "new-password-123";

  const result = await new AuthService(db, config).resetUserPassword(
    ADMIN_ID,
    password,
  );

  assert.deepEqual(result, { success: true });
  const passwordUpdate = queries.find((query) =>
    query.text.includes("UPDATE users SET password_hash"),
  );
  assert.ok(passwordUpdate);
  assert.notEqual(passwordUpdate.values?.[1], password);
  assert.ok(
    queries.some((query) =>
      query.text.includes("UPDATE refresh_tokens SET revoked_at"),
    ),
  );
});

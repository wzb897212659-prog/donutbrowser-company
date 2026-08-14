import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { AuthService } from "./auth.js";
import type { Database } from "./db.js";
import { randomToken, sha256 } from "./security.js";
import type { AuthUser, ProfileAccessAction } from "./types.js";

type ProfileRow = {
  id: string;
  name: string;
  owner_id: string;
  browser_version: string | null;
  revision: string;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  assigned_user_ids?: string[] | null;
};

export type BatchTransferResult =
  | {
      status: 200;
      success: true;
      updated: number;
      profileIds: string[];
      targetUserId: string;
    }
  | {
      status: 400 | 403 | 404 | 409;
      success: false;
      code: string;
      profileIds?: string[];
    };

export class ProfileService {
  constructor(
    private readonly db: Database,
    private readonly auth: AuthService,
  ) {}

  async canAccess(
    user: AuthUser,
    profileId: string,
    includeDeleted = false,
  ): Promise<boolean> {
    const result = await this.db.query<{ allowed: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM profiles p
         WHERE p.id = $1
           AND ($3::boolean OR p.deleted_at IS NULL)
           AND ($2 = 'super_admin' OR EXISTS (
             SELECT 1 FROM profile_assignments a WHERE a.profile_id = p.id AND a.user_id = $4
           ))
       ) AS allowed`,
      [profileId, user.role, includeDeleted, user.id],
    );
    return result.rows[0]?.allowed || false;
  }

  async list(user: AuthUser, includeDeleted = false) {
    const result = await this.db.query<ProfileRow>(
      `SELECT DISTINCT p.*,
         CASE WHEN $2 = 'super_admin' THEN ARRAY(
           SELECT pa.user_id::text FROM profile_assignments pa
           WHERE pa.profile_id = p.id ORDER BY pa.assigned_at
         ) ELSE NULL END AS assigned_user_ids
       FROM profiles p
       LEFT JOIN profile_assignments a ON a.profile_id = p.id
       WHERE ($1::boolean OR p.deleted_at IS NULL)
         AND ($2 = 'super_admin' OR a.user_id = $3)
       ORDER BY p.updated_at DESC
       LIMIT 500`,
      [includeDeleted && user.role === "super_admin", user.role, user.id],
    );
    return result.rows.map(this.publicProfile);
  }

  async create(
    user: AuthUser,
    input: { id?: string; name: string; browserVersion?: string },
  ) {
    const id = input.id || randomUUID();
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error("INVALID_PROFILE_ID");
    const name = input.name.trim();
    if (!name || name.length > 255) throw new Error("INVALID_PROFILE_NAME");
    const row = await this.db.transaction(async (client) => {
      const inserted = await client.query<ProfileRow>(
        `INSERT INTO profiles (id, name, owner_id, browser_version)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [id, name, user.id, input.browserVersion || null],
      );
      await client.query(
        "INSERT INTO profile_assignments (profile_id, user_id) VALUES ($1, $2)",
        [id, user.id],
      );
      return inserted.rows[0];
    });
    await this.auth.audit(user.id, "profile.create", id, undefined, { name });
    return this.publicProfile(row);
  }

  async ensureCreatedFromSync(
    user: AuthUser,
    profileId: string,
  ): Promise<boolean> {
    if (!/^[0-9a-fA-F-]{36}$/.test(profileId)) return false;
    await this.db.transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO profiles (id, name, owner_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [profileId, `Environment ${profileId.slice(0, 8)}`, user.id],
      );
      if (inserted.rows[0]) {
        await client.query(
          `INSERT INTO profile_assignments (profile_id, user_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [profileId, user.id],
        );
      }
    });
    const allowed = await this.canAccess(user, profileId);
    if (allowed)
      await this.auth.audit(user.id, "profile.sync_register", profileId);
    return allowed;
  }

  async update(
    user: AuthUser,
    profileId: string,
    input: { name?: string; browserVersion?: string },
  ) {
    if (!(await this.canAccess(user, profileId))) return null;
    const result = await this.db.query<ProfileRow>(
      `UPDATE profiles SET
         name = COALESCE($2, name),
         browser_version = COALESCE($3, browser_version),
         updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [profileId, input.name?.trim() || null, input.browserVersion || null],
    );
    if (!result.rows[0]) return null;
    await this.auth.audit(
      user.id,
      "profile.update",
      profileId,
      undefined,
      input,
    );
    return this.publicProfile(result.rows[0]);
  }

  async setDeleted(
    user: AuthUser,
    profileId: string,
    deleted: boolean,
  ): Promise<boolean> {
    if (user.role !== "super_admin") return false;
    const result = await this.db.query(
      `UPDATE profiles SET deleted_at = $2, updated_at = now()
       WHERE id = $1 RETURNING id`,
      [profileId, deleted ? new Date() : null],
    );
    if (!result.rowCount) return false;
    await this.auth.audit(
      user.id,
      deleted ? "profile.delete" : "profile.restore",
      profileId,
    );
    return true;
  }

  async replaceAssignments(
    user: AuthUser,
    profileId: string,
    userIds: string[],
  ) {
    if (user.role !== "super_admin") return false;
    await this.db.transaction(async (client) => {
      await client.query("SELECT id FROM profiles WHERE id = $1 FOR UPDATE", [
        profileId,
      ]);
      await client.query(
        "DELETE FROM profile_assignments WHERE profile_id = $1",
        [profileId],
      );
      for (const userId of [...new Set(userIds)]) {
        await client.query(
          `INSERT INTO profile_assignments (profile_id, user_id)
           SELECT $1, id FROM users WHERE id = $2 AND active = true`,
          [profileId, userId],
        );
      }
    });
    await this.auth.audit(
      user.id,
      "profile.assignments.replace",
      profileId,
      undefined,
      { userIds },
    );
    return true;
  }

  async batchTransfer(
    user: AuthUser,
    profileIds: string[],
    targetUserId: string,
  ): Promise<BatchTransferResult> {
    if (user.role !== "super_admin") {
      return { status: 403, success: false, code: "FORBIDDEN" };
    }
    const uniqueProfileIds = [...new Set(profileIds)];
    if (
      uniqueProfileIds.length === 0 ||
      uniqueProfileIds.length > 500 ||
      uniqueProfileIds.some((id) => !/^[0-9a-fA-F-]{36}$/.test(id)) ||
      !/^[0-9a-fA-F-]{36}$/.test(targetUserId)
    ) {
      return { status: 400, success: false, code: "INVALID_BATCH_TRANSFER" };
    }

    const result = await this.db.transaction(
      async (client): Promise<BatchTransferResult> => {
        const target = await client.query<{ id: string }>(
          "SELECT id FROM users WHERE id = $1 AND role = 'admin' AND active = true FOR UPDATE",
          [targetUserId],
        );
        if (!target.rows[0]) {
          return {
            status: 404,
            success: false,
            code: "ACTIVE_ADMIN_NOT_FOUND",
          };
        }

        const profiles = await client.query<{ id: string }>(
          `SELECT id FROM profiles
         WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
         ORDER BY id FOR UPDATE`,
          [uniqueProfileIds],
        );
        if (profiles.rows.length !== uniqueProfileIds.length) {
          return { status: 404, success: false, code: "PROFILE_NOT_FOUND" };
        }

        await client.query(
          "DELETE FROM profile_leases WHERE profile_id = ANY($1::uuid[]) AND expires_at <= now()",
          [uniqueProfileIds],
        );
        const locked = await client.query<{ id: string }>(
          `SELECT profile_id::text AS id FROM profile_leases
         WHERE profile_id = ANY($1::uuid[]) AND expires_at > now()
         ORDER BY profile_id`,
          [uniqueProfileIds],
        );
        if (locked.rows.length > 0) {
          return {
            status: 409,
            success: false,
            code: "PROFILES_LOCKED",
            profileIds: locked.rows.map((row) => row.id),
          };
        }

        await client.query(
          `UPDATE profiles SET owner_id = $2, updated_at = now()
         WHERE id = ANY($1::uuid[])`,
          [uniqueProfileIds, targetUserId],
        );
        await client.query(
          "DELETE FROM profile_assignments WHERE profile_id = ANY($1::uuid[])",
          [uniqueProfileIds],
        );
        await client.query(
          `INSERT INTO profile_assignments (profile_id, user_id)
         SELECT unnest($1::uuid[]), $2::uuid`,
          [uniqueProfileIds, targetUserId],
        );
        return {
          status: 200,
          success: true,
          updated: uniqueProfileIds.length,
          profileIds: uniqueProfileIds,
          targetUserId,
        };
      },
    );

    if (result.success) {
      await this.auth.audit(
        user.id,
        "profile.assignments.batch_transfer",
        undefined,
        targetUserId,
        { profileIds: result.profileIds, updated: result.updated },
      );
    }
    return result;
  }

  async acquireLease(user: AuthUser, profileId: string, deviceId: string) {
    if (!(await this.canAccess(user, profileId)))
      return { status: 403, code: "FORBIDDEN" } as const;
    if (!/^[A-Za-z0-9_.-]{3,128}$/.test(deviceId))
      return { status: 400, code: "INVALID_DEVICE_ID" } as const;
    const token = randomToken(32);
    const result = await this.db.transaction(async (client) => {
      await client.query("SELECT id FROM profiles WHERE id = $1 FOR UPDATE", [
        profileId,
      ]);
      await client.query(
        "DELETE FROM profile_leases WHERE profile_id = $1 AND expires_at <= now()",
        [profileId],
      );
      const existing = await client.query<{
        user_id: string;
        device_id: string;
        expires_at: Date;
      }>(
        "SELECT user_id, device_id, expires_at FROM profile_leases WHERE profile_id = $1",
        [profileId],
      );
      if (existing.rows[0]) return { conflict: existing.rows[0] } as const;
      await client.query(
        `INSERT INTO profile_leases
           (profile_id, user_id, device_id, lease_token_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '120 seconds')`,
        [profileId, user.id, deviceId, sha256(token)],
      );
      return { ok: true } as const;
    });
    if ("conflict" in result)
      return {
        status: 409,
        success: false,
        code: "PROFILE_LOCKED",
        lockedBy: result.conflict!.user_id,
        lockedByEmail: "another administrator",
        lock: result.conflict!,
      } as const;
    await this.auth.audit(user.id, "lease.acquire", profileId, undefined, {
      deviceId,
    });
    return {
      status: 200,
      success: true,
      leaseToken: token,
      expiresIn: 120,
    } as const;
  }

  async heartbeat(user: AuthUser, profileId: string, token: string) {
    const result = await this.db.query(
      `UPDATE profile_leases SET heartbeat_at = now(), expires_at = now() + interval '120 seconds'
       WHERE profile_id = $1 AND user_id = $2 AND lease_token_hash = $3 AND expires_at > now()
       RETURNING profile_id`,
      [profileId, user.id, sha256(token)],
    );
    return Boolean(result.rowCount);
  }

  async releaseLease(
    user: AuthUser,
    profileId: string,
    token?: string,
    force = false,
  ) {
    if (force && user.role !== "super_admin") return false;
    const params: unknown[] = [profileId];
    let where = "profile_id = $1";
    if (!force) {
      params.push(user.id, sha256(token || ""));
      where += " AND user_id = $2 AND lease_token_hash = $3";
    }
    const result = await this.db.query(
      `DELETE FROM profile_leases WHERE ${where} RETURNING profile_id`,
      params,
    );
    if (result.rowCount)
      await this.auth.audit(
        user.id,
        force ? "lease.force_release" : "lease.release",
        profileId,
      );
    return Boolean(result.rowCount);
  }

  async listLeases(user: AuthUser) {
    const result = await this.db.query(
      `SELECT l.profile_id AS "profileId", l.user_id AS "lockedBy",
              u.username AS "lockedByEmail", l.acquired_at AS "lockedAt",
              l.expires_at AS "expiresAt", l.device_id AS "deviceId"
       FROM profile_leases l
       JOIN users u ON u.id = l.user_id
       JOIN profiles p ON p.id = l.profile_id
       LEFT JOIN profile_assignments a ON a.profile_id = p.id AND a.user_id = $1
       WHERE l.expires_at > now() AND ($2 = 'super_admin' OR a.user_id IS NOT NULL)`,
      [user.id, user.role],
    );
    return result.rows;
  }

  async prepareSync(
    user: AuthUser,
    profileId: string,
    action: ProfileAccessAction,
  ) {
    if (!(await this.canAccess(user, profileId, action === "delete")))
      return null;
    const result = await this.db.query<ProfileRow>(
      "SELECT * FROM profiles WHERE id = $1",
      [profileId],
    );
    return result.rows[0] ? this.publicProfile(result.rows[0]) : null;
  }

  async commitRevision(
    user: AuthUser,
    profileId: string,
    baseRevision: number,
  ) {
    if (!(await this.canAccess(user, profileId)))
      return { status: 403, code: "FORBIDDEN" } as const;
    const result = await this.db.query<{ revision: string }>(
      `UPDATE profiles p SET revision = p.revision + 1, updated_at = now()
       WHERE p.id = $1 AND p.revision = $2 AND p.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM profile_leases l
           WHERE l.profile_id = p.id AND l.user_id = $3 AND l.expires_at > now()
         )
       RETURNING p.revision`,
      [profileId, baseRevision, user.id],
    );
    if (!result.rows[0]) {
      const current = await this.db.query<{ revision: string }>(
        "SELECT revision FROM profiles WHERE id = $1",
        [profileId],
      );
      return {
        status: 409,
        code: "REMOTE_REVISION_CHANGED_OR_LEASE_EXPIRED",
        revision: Number(current.rows[0]?.revision || 0),
      } as const;
    }
    const revision = Number(result.rows[0].revision);
    await this.auth.audit(user.id, "sync.commit", profileId, undefined, {
      baseRevision,
      revision,
    });
    return { status: 200, revision } as const;
  }

  private publicProfile(row: ProfileRow) {
    return {
      id: row.id,
      name: row.name,
      ownerId: row.owner_id,
      browserVersion: row.browser_version,
      revision: Number(row.revision),
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.assigned_user_ids
        ? { assignedUserIds: row.assigned_user_ids }
        : {}),
    };
  }
}

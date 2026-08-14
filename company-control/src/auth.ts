import { randomUUID } from "node:crypto";
import type { NextFunction, Response } from "express";
import jwt from "jsonwebtoken";
import type { AppConfig } from "./config.js";
import type { Database } from "./db.js";
import {
  hashPassword,
  randomToken,
  sha256,
  validatePassword,
  validateUsername,
  verifyPassword,
} from "./security.js";
import type { AuthenticatedRequest, AuthUser, Role } from "./types.js";

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  role: Role;
  active: boolean;
  failed_attempts: number;
  locked_until: Date | null;
  token_version: number;
};

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  async bootstrap(): Promise<void> {
    if (!this.config.bootstrapUsername || !this.config.bootstrapPassword)
      return;
    const count = await this.db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM users",
    );
    if (Number(count.rows[0]?.count || 0) > 0) return;
    const error = validatePassword(this.config.bootstrapPassword);
    if (error) throw new Error(`Bootstrap password rejected: ${error}`);
    await this.db.query(
      `INSERT INTO users (id, username, password_hash, role)
       VALUES ($1, $2, $3, 'super_admin')`,
      [
        randomUUID(),
        this.config.bootstrapUsername,
        await hashPassword(this.config.bootstrapPassword),
      ],
    );
  }

  signAccessToken(user: AuthUser): string {
    return jwt.sign(
      {
        role: user.role,
        username: user.username,
        tokenVersion: user.tokenVersion,
        prefix: "company/",
        profileLimit: 500,
      },
      this.config.jwtPrivateKey,
      {
        algorithm: "RS256",
        subject: user.id,
        issuer: this.config.jwtIssuer,
        audience: this.config.jwtAudience,
        expiresIn: "15m",
      },
    );
  }

  async issueTokens(
    row: UserRow,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const refreshToken = randomToken(48);
    await this.db.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '30 days')`,
      [randomUUID(), row.id, sha256(refreshToken)],
    );
    return {
      accessToken: this.signAccessToken({
        id: row.id,
        username: row.username,
        role: row.role,
        tokenVersion: row.token_version,
      }),
      refreshToken,
      expiresIn: 900,
    };
  }

  async login(username: string, password: string, ip?: string) {
    const result = await this.db.query<UserRow>(
      "SELECT * FROM users WHERE username = $1",
      [username],
    );
    const row = result.rows[0];
    if (!row || !row.active)
      return { error: "INVALID_CREDENTIALS", status: 401 } as const;
    if (row.locked_until && row.locked_until.getTime() > Date.now()) {
      return { error: "ACCOUNT_LOCKED", status: 423 } as const;
    }
    if (!(await verifyPassword(row.password_hash, password))) {
      await this.db.query(
        `UPDATE users SET
           failed_attempts = failed_attempts + 1,
           locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '30 minutes' ELSE NULL END,
           updated_at = now()
         WHERE id = $1`,
        [row.id],
      );
      await this.audit(
        row.id,
        "auth.login_failed",
        undefined,
        undefined,
        { username },
        ip,
      );
      return { error: "INVALID_CREDENTIALS", status: 401 } as const;
    }
    await this.db.query(
      "UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1",
      [row.id],
    );
    await this.audit(row.id, "auth.login", undefined, undefined, {}, ip);
    return {
      tokens: await this.issueTokens(row),
      user: this.publicUser(row),
    } as const;
  }

  async refresh(refreshToken: string) {
    return this.db.transaction(async (client) => {
      const result = await client.query<UserRow & { refresh_id: string }>(
        `SELECT u.*, rt.id AS refresh_id
         FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
         WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > now()
         FOR UPDATE`,
        [sha256(refreshToken)],
      );
      const row = result.rows[0];
      if (!row || !row.active) return null;
      await client.query(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1",
        [row.refresh_id],
      );
      const replacement = randomToken(48);
      await client.query(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '30 days')`,
        [randomUUID(), row.id, sha256(replacement)],
      );
      return {
        accessToken: this.signAccessToken({
          id: row.id,
          username: row.username,
          role: row.role,
          tokenVersion: row.token_version,
        }),
        refreshToken: replacement,
        expiresIn: 900,
      };
    });
  }

  async authenticate(req: AuthenticatedRequest): Promise<AuthUser | null> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    try {
      const payload = jwt.verify(header.slice(7), this.config.jwtPublicKey, {
        algorithms: ["RS256"],
        issuer: this.config.jwtIssuer,
        audience: this.config.jwtAudience,
      }) as jwt.JwtPayload;
      if (typeof payload.sub !== "string") return null;
      const result = await this.db.query<UserRow>(
        "SELECT * FROM users WHERE id = $1",
        [payload.sub],
      );
      const row = result.rows[0];
      if (!row?.active || row.token_version !== payload.tokenVersion)
        return null;
      return {
        id: row.id,
        username: row.username,
        role: row.role,
        tokenVersion: row.token_version,
      };
    } catch {
      return null;
    }
  }

  middleware = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const user = await this.authenticate(req);
    if (!user) return res.status(401).json({ code: "UNAUTHORIZED" });
    req.authUser = user;
    next();
  };

  requireSuperAdmin(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) {
    if (req.authUser?.role !== "super_admin")
      return res.status(403).json({ code: "FORBIDDEN" });
    next();
  }

  async createUser(username: string, password: string, role: Role) {
    if (!validateUsername(username))
      return { error: "INVALID_USERNAME" } as const;
    const passwordError = validatePassword(password);
    if (passwordError) return { error: passwordError } as const;
    if (role !== "admin" && role !== "super_admin")
      return { error: "INVALID_ROLE" } as const;
    const id = randomUUID();
    try {
      await this.db.query(
        "INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, $4)",
        [id, username, await hashPassword(password), role],
      );
      return { user: { id, username, role, active: true } } as const;
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        return { error: "USERNAME_EXISTS" } as const;
      throw error;
    }
  }

  async resetUserPassword(targetUserId: string, password: string) {
    const passwordError = validatePassword(password);
    if (passwordError) return { error: passwordError, status: 400 } as const;

    const passwordHash = await hashPassword(password);
    const result = await this.db.transaction(async (client) => {
      const target = await client.query<{ id: string; role: Role }>(
        "SELECT id, role FROM users WHERE id = $1 FOR UPDATE",
        [targetUserId],
      );
      const user = target.rows[0];
      if (!user) return { error: "USER_NOT_FOUND", status: 404 } as const;
      if (user.role !== "admin") {
        return {
          error: "SUPER_ADMIN_PASSWORD_RESET_FORBIDDEN",
          status: 403,
        } as const;
      }
      await client.query(
        `UPDATE users SET password_hash = $2, token_version = token_version + 1,
           failed_attempts = 0, locked_until = NULL, updated_at = now()
         WHERE id = $1`,
        [targetUserId, passwordHash],
      );
      await client.query(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
        [targetUserId],
      );
      return { success: true } as const;
    });
    return result;
  }

  async audit(
    actorUserId: string | undefined,
    action: string,
    profileId?: string,
    targetUserId?: string,
    details: Record<string, unknown> = {},
    ip?: string,
  ) {
    await this.db.query(
      `INSERT INTO audit_events (actor_user_id, action, profile_id, target_user_id, details, ip)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        actorUserId || null,
        action,
        profileId || null,
        targetUserId || null,
        JSON.stringify(details),
        ip || null,
      ],
    );
  }

  publicUser(row: UserRow) {
    return {
      id: row.id,
      username: row.username,
      role: row.role,
      active: row.active,
    };
  }
}

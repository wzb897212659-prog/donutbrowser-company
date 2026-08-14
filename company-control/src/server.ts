import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { AuthService } from "./auth.js";
import { loadConfig } from "./config.js";
import { Database } from "./db.js";
import {
  isProfileCollectionKey,
  profileIdFromObjectKey,
} from "./object-key.js";
import { ProfileService } from "./profile-service.js";
import type {
  AuthenticatedRequest,
  ProfileAccessAction,
  Role,
} from "./types.js";

const config = loadConfig();
const db = new Database(config.databaseUrl);
const auth = new AuthService(db, config);
const profiles = new ProfileService(db, auth);
const app = express();

const routeParam = (value: string | string[]): string =>
  Array.isArray(value) ? value[0] || "" : value;

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
app.use("/admin", express.static(publicDir, { index: "admin.html" }));

const asyncRoute =
  (
    fn: (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction,
    ) => Promise<unknown>,
  ) =>
  (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    void fn(req, res, next).catch(next);
  };

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get(
  "/readyz",
  asyncRoute(async (_req, res) => {
    await db.query("SELECT 1");
    res.json({ status: "ready", database: true });
  }),
);

app.post(
  "/auth/login",
  asyncRoute(async (req, res) => {
    const username =
      typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password =
      typeof req.body?.password === "string" ? req.body.password : "";
    const result = await auth.login(username, password, req.ip);
    if ("error" in result)
      return res.status(result.status || 401).json({ code: result.error });
    res.json({
      ...result.tokens,
      user: result.user,
      syncServerUrl: config.syncServerUrl,
      offlineAuthorizationExpiresAt: new Date(
        Date.now() + config.offlineAuthDays * 86_400_000,
      ).toISOString(),
    });
  }),
);

app.post(
  "/auth/refresh",
  asyncRoute(async (req, res) => {
    const token =
      typeof req.body?.refreshToken === "string" ? req.body.refreshToken : "";
    const result = await auth.refresh(token);
    if (!result) return res.status(401).json({ code: "INVALID_REFRESH_TOKEN" });
    res.json(result);
  }),
);

app.use((req: AuthenticatedRequest, res, next) => {
  if (
    req.path.startsWith("/internal/") ||
    req.path.startsWith("/auth/internal/") ||
    req.path.startsWith("/api/internal/") ||
    req.path.startsWith("/api/auth/internal/")
  ) {
    return next();
  }
  return auth.middleware(req, res, next);
});

app.get("/auth/me", (req: AuthenticatedRequest, res) => res.json(req.authUser));
app.post(
  "/auth/logout",
  asyncRoute(async (req, res) => {
    const refreshToken =
      typeof req.body?.refreshToken === "string" ? req.body.refreshToken : "";
    if (refreshToken) {
      const { sha256 } = await import("./security.js");
      await db.query(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1",
        [sha256(refreshToken)],
      );
    }
    await auth.audit(
      req.authUser?.id,
      "auth.logout",
      undefined,
      undefined,
      {},
      req.ip,
    );
    res.status(204).end();
  }),
);

app.get(
  "/users",
  auth.requireSuperAdmin.bind(auth),
  asyncRoute(async (_req, res) => {
    const result = await db.query(
      `SELECT u.id, u.username, u.role, u.active,
              u.created_at AS "createdAt", u.updated_at AS "updatedAt",
              count(p.id)::integer AS "assignedProfileCount"
       FROM users u
       LEFT JOIN profile_assignments a ON a.user_id = u.id
       LEFT JOIN profiles p ON p.id = a.profile_id AND p.deleted_at IS NULL
       GROUP BY u.id
       ORDER BY u.created_at`,
    );
    res.json(result.rows);
  }),
);
app.get(
  "/audit-events",
  auth.requireSuperAdmin.bind(auth),
  asyncRoute(async (_req, res) => {
    const result = await db.query(
      `SELECT a.id, a.action, a.profile_id AS "profileId",
              actor.username AS "actorUsername", target.username AS "targetUsername",
              a.details, a.created_at AS "createdAt"
       FROM audit_events a
       LEFT JOIN users actor ON actor.id = a.actor_user_id
       LEFT JOIN users target ON target.id = a.target_user_id
       ORDER BY a.created_at DESC LIMIT 500`,
    );
    res.json(result.rows);
  }),
);
app.post(
  "/users",
  auth.requireSuperAdmin.bind(auth),
  asyncRoute(async (req, res) => {
    const result = await auth.createUser(
      req.body?.username,
      req.body?.password,
      req.body?.role as Role,
    );
    if ("error" in result)
      return res
        .status(result.error === "USERNAME_EXISTS" ? 409 : 400)
        .json({ code: result.error });
    await auth.audit(
      req.authUser?.id,
      "user.create",
      undefined,
      result.user.id,
      { role: result.user.role },
      req.ip,
    );
    res.status(201).json(result.user);
  }),
);
app.patch(
  "/users/:id/status",
  auth.requireSuperAdmin.bind(auth),
  asyncRoute(async (req, res) => {
    const active = req.body?.active === true;
    const result = await db.query(
      `UPDATE users SET active = $2, token_version = token_version + 1, updated_at = now()
       WHERE id = $1 RETURNING id, username, role, active`,
      [req.params.id, active],
    );
    if (!result.rows[0])
      return res.status(404).json({ code: "USER_NOT_FOUND" });
    if (!active)
      await db.query(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1",
        [req.params.id],
      );
    await auth.audit(
      req.authUser?.id,
      active ? "user.enable" : "user.disable",
      undefined,
      routeParam(req.params.id),
      {},
      req.ip,
    );
    res.json(result.rows[0]);
  }),
);
app.put(
  "/users/:id/password",
  auth.requireSuperAdmin.bind(auth),
  asyncRoute(async (req, res) => {
    const password =
      typeof req.body?.password === "string" ? req.body.password : "";
    const result = await auth.resetUserPassword(
      routeParam(req.params.id),
      password,
    );
    if ("error" in result)
      return res.status(result.status || 400).json({ code: result.error });
    await auth.audit(
      req.authUser?.id,
      "user.password.reset",
      undefined,
      routeParam(req.params.id),
      {},
      req.ip,
    );
    res.status(204).end();
  }),
);

app.get(
  "/profiles",
  asyncRoute(async (req, res) => {
    res.json(
      await profiles.list(req.authUser!, req.query.includeDeleted === "true"),
    );
  }),
);
app.post(
  "/profiles",
  asyncRoute(async (req, res) => {
    try {
      res.status(201).json(
        await profiles.create(req.authUser!, {
          id: req.body?.id,
          name: req.body?.name,
          browserVersion: req.body?.browserVersion,
        }),
      );
    } catch (error) {
      res.status(400).json({
        code: error instanceof Error ? error.message : "INVALID_PROFILE",
      });
    }
  }),
);
app.patch(
  "/profiles/:id",
  asyncRoute(async (req, res) => {
    const profile = await profiles.update(
      req.authUser!,
      routeParam(req.params.id),
      req.body || {},
    );
    if (!profile) return res.status(404).json({ code: "PROFILE_NOT_FOUND" });
    res.json(profile);
  }),
);
app.delete(
  "/profiles/:id",
  asyncRoute(async (req, res) => {
    if (
      !(await profiles.setDeleted(
        req.authUser!,
        routeParam(req.params.id),
        true,
      ))
    )
      return res.status(403).json({ code: "FORBIDDEN" });
    res.status(204).end();
  }),
);
app.post(
  "/profiles/:id/restore",
  asyncRoute(async (req, res) => {
    if (
      !(await profiles.setDeleted(
        req.authUser!,
        routeParam(req.params.id),
        false,
      ))
    )
      return res.status(403).json({ code: "FORBIDDEN" });
    res.status(204).end();
  }),
);
app.put(
  "/profiles/:id/assignments",
  asyncRoute(async (req, res) => {
    if (!Array.isArray(req.body?.userIds))
      return res.status(400).json({ code: "INVALID_ASSIGNMENTS" });
    if (
      !(await profiles.replaceAssignments(
        req.authUser!,
        routeParam(req.params.id),
        req.body.userIds,
      ))
    )
      return res.status(403).json({ code: "FORBIDDEN" });
    res.status(204).end();
  }),
);
app.post(
  "/profiles/batch-transfer",
  auth.requireSuperAdmin.bind(auth),
  asyncRoute(async (req, res) => {
    if (
      !Array.isArray(req.body?.profileIds) ||
      typeof req.body?.targetUserId !== "string"
    ) {
      return res.status(400).json({ code: "INVALID_BATCH_TRANSFER" });
    }
    const result = await profiles.batchTransfer(
      req.authUser!,
      req.body.profileIds,
      req.body.targetUserId,
    );
    res.status(result.status).json(result);
  }),
);
app.get(
  "/profiles/:id/assignments",
  auth.requireSuperAdmin.bind(auth),
  asyncRoute(async (req, res) => {
    const result = await db.query<{ userId: string }>(
      `SELECT user_id AS "userId" FROM profile_assignments WHERE profile_id = $1 ORDER BY assigned_at`,
      [routeParam(req.params.id)],
    );
    res.json(result.rows.map((row) => row.userId));
  }),
);

app.get(
  "/profile-locks",
  asyncRoute(async (req, res) =>
    res.json(await profiles.listLeases(req.authUser!)),
  ),
);
app.post(
  "/profile-locks/:id",
  asyncRoute(async (req, res) => {
    const result = await profiles.acquireLease(
      req.authUser!,
      routeParam(req.params.id),
      String(req.body?.deviceId || req.headers["x-device-id"] || ""),
    );
    res.status(result.status).json(result);
  }),
);
app.post(
  "/profile-locks/:id/heartbeat",
  asyncRoute(async (req, res) => {
    if (
      !(await profiles.heartbeat(
        req.authUser!,
        routeParam(req.params.id),
        String(req.body?.leaseToken || req.headers["x-lease-token"] || ""),
      ))
    ) {
      return res.status(409).json({ code: "LEASE_EXPIRED" });
    }
    res.json({ success: true, expiresIn: 120 });
  }),
);
app.delete(
  "/profile-locks/:id",
  asyncRoute(async (req, res) => {
    if (
      !(await profiles.releaseLease(
        req.authUser!,
        routeParam(req.params.id),
        String(req.body?.leaseToken || req.headers["x-lease-token"] || ""),
        false,
      ))
    ) {
      return res.status(409).json({ code: "LEASE_NOT_HELD" });
    }
    res.status(204).end();
  }),
);
app.delete(
  "/profile-locks/:id/force",
  asyncRoute(async (req, res) => {
    if (
      !(await profiles.releaseLease(
        req.authUser!,
        routeParam(req.params.id),
        undefined,
        true,
      ))
    )
      return res.status(403).json({ code: "FORBIDDEN" });
    res.status(204).end();
  }),
);

app.post(
  "/sync/prepare",
  asyncRoute(async (req, res) => {
    const action = (req.body?.action || "read") as ProfileAccessAction;
    if (!["read", "write", "delete", "list"].includes(action))
      return res.status(400).json({ code: "INVALID_ACTION" });
    const profile = await profiles.prepareSync(
      req.authUser!,
      req.body?.profileId,
      action,
    );
    if (!profile) return res.status(403).json({ code: "FORBIDDEN" });
    res.json(profile);
  }),
);
app.post(
  "/sync/commit",
  asyncRoute(async (req, res) => {
    const result = await profiles.commitRevision(
      req.authUser!,
      req.body?.profileId,
      Number(req.body?.baseRevision),
    );
    res.status(result.status).json(result);
  }),
);

app.post(
  ["/internal/sync/authorize", "/api/internal/sync/authorize"],
  asyncRoute(async (req, res) => {
    if (req.headers["x-internal-key"] !== config.internalApiKey)
      return res.status(401).json({ allowed: false });
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const fake = {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as AuthenticatedRequest;
    const user = await auth.authenticate(fake);
    if (!user) return res.status(401).json({ allowed: false });
    const key = typeof req.body?.key === "string" ? req.body.key : "";
    const action = (req.body?.action || "read") as ProfileAccessAction;
    const profileId = profileIdFromObjectKey(key);
    if (action === "delete" && user.role !== "super_admin") {
      return res.status(403).json({ allowed: false });
    }
    if (
      profileId &&
      !(await profiles.canAccess(user, profileId, action === "delete"))
    ) {
      if (action === "write") {
        if (!(await profiles.ensureCreatedFromSync(user, profileId))) {
          return res.status(403).json({ allowed: false });
        }
      } else {
        return res.status(403).json({ allowed: false });
      }
    }
    if (!profileId) {
      if (!(action === "list" && isProfileCollectionKey(key))) {
        return res.status(403).json({ allowed: false });
      }
    }
    let allowedProfileIds: string[] | undefined;
    if (action === "list" && isProfileCollectionKey(key)) {
      const visible = await profiles.list(user, false);
      allowedProfileIds = visible.map((profile) => profile.id);
    }
    res.json({
      allowed: true,
      subject: user.id,
      role: user.role,
      prefix: "company/",
      profileId,
      allowedProfileIds,
    });
  }),
);

app.post(
  ["/auth/internal/team-scope", "/api/auth/internal/team-scope"],
  asyncRoute(async (req, res) => {
    if (req.headers["x-internal-key"] !== config.internalApiKey)
      return res.status(401).end();
    res.json(null);
  }),
);

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  res.status(500).json({ code: "INTERNAL_ERROR" });
});

await db.migrate();
await auth.bootstrap();
const runMaintenance = async () => {
  await db.query("DELETE FROM profile_leases WHERE expires_at <= now()");
  await db.query(
    "DELETE FROM refresh_tokens WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '30 days'",
  );
  await db.query(
    "DELETE FROM audit_events WHERE created_at < now() - interval '180 days'",
  );
};
await runMaintenance();
setInterval(
  () => void runMaintenance().catch(console.error),
  24 * 60 * 60 * 1000,
).unref();
app.listen(config.port, "0.0.0.0", () => {
  console.log(`Sanhe Donut control API listening on ${config.port}`);
});

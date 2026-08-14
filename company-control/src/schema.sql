CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  username varchar(64) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role varchar(32) NOT NULL CHECK (role IN ('super_admin', 'admin')),
  active boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  token_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY,
  name varchar(255) NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id),
  browser_version varchar(64),
  revision bigint NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profile_assignments (
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, user_id)
);

CREATE TABLE IF NOT EXISTS profile_leases (
  profile_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  device_id varchar(128) NOT NULL,
  lease_token_hash char(64) NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id),
  action varchar(96) NOT NULL,
  profile_id uuid,
  target_user_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assignments_user ON profile_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_updated ON profiles(updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id, expires_at);

-- The six tables of the license design's "What it keeps". Times are unix seconds; a column whose
-- value can be unknown is nullable and stays null, never 0 or ''.

CREATE TABLE subscriptions (
  polar_subscription_id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('User', 'Organization')),
  plan TEXT NOT NULL CHECK (plan IN ('private-repo', 'personal', 'organization', 'internal')),
  seats INTEGER,
  repo_ids TEXT,              -- JSON array of repo ids; Private repo plans only
  source TEXT NOT NULL,
  period_end INTEGER,
  cancel_at_period_end INTEGER,
  modified_at INTEGER NOT NULL,
  raw TEXT NOT NULL           -- the provider's subscription object as JSON
);
CREATE INDEX subscriptions_owner ON subscriptions (owner_id);

CREATE TABLE repos (
  repo_id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  visibility TEXT CHECK (visibility IN ('public', 'private', 'internal')),
  private_repo_licensed INTEGER,
  installation_id INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX repos_owner ON repos (owner_id);

CREATE TABLE seats (
  licensee_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  first_key_at INTEGER NOT NULL,
  last_key_at INTEGER NOT NULL,
  PRIMARY KEY (licensee_id, user_id)
);

CREATE TABLE overuse (
  licensee_id INTEGER PRIMARY KEY,
  grace_started_at INTEGER,
  grace_spent_until INTEGER
);

CREATE TABLE usage (
  repo_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,          -- YYYY-MM-DD, UTC
  PRIMARY KEY (repo_id, user_id, day)
);

CREATE TABLE signing_keys (
  kid TEXT PRIMARY KEY,
  pub TEXT NOT NULL,
  cert TEXT NOT NULL,
  nbf INTEGER NOT NULL,
  exp INTEGER NOT NULL
);

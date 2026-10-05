-- Fleets-only billing (decision 60): one repo is free and the paid plans are the Personal and
-- Organization fleets, so Private repo, its repo_ids and the repo flag it set are retired, and so
-- are the seat, overuse and usage tables the session keys kept. No customer holds a row this
-- drops; a Private repo subscription row, of which there are none, is not copied.

CREATE TABLE subscriptions_fleets (
  polar_subscription_id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('User', 'Organization')),
  plan TEXT NOT NULL CHECK (plan IN ('personal', 'organization', 'internal')),
  seats INTEGER,
  source TEXT NOT NULL,
  period_end INTEGER,
  cancel_at_period_end INTEGER,
  modified_at INTEGER NOT NULL,
  raw TEXT NOT NULL,          -- the provider's subscription object as JSON
  status TEXT,
  ended_at INTEGER,
  product_id TEXT,
  interval TEXT CHECK (interval IN ('month', 'year'))
);
INSERT INTO subscriptions_fleets (polar_subscription_id, owner_id, owner_type, plan, seats, source, period_end, cancel_at_period_end, modified_at, raw, status, ended_at, product_id, interval)
  SELECT polar_subscription_id, owner_id, owner_type, plan, seats, source, period_end, cancel_at_period_end, modified_at, raw, status, ended_at, product_id, interval
  FROM subscriptions WHERE plan <> 'private-repo';
DROP TABLE subscriptions;
ALTER TABLE subscriptions_fleets RENAME TO subscriptions;
CREATE INDEX subscriptions_owner ON subscriptions (owner_id);

ALTER TABLE repos DROP COLUMN private_repo_licensed;

DROP TABLE seats;
DROP TABLE overuse;
DROP TABLE usage;

-- What the key Worker needs about a repo that no OIDC claim or webhook alone carries, and the
-- sync Worker's last-success stamps the alerts read. default_branch stays null until the sync
-- Worker has read the repo from GitHub.

ALTER TABLE repos ADD COLUMN full_name TEXT;
ALTER TABLE repos ADD COLUMN owner_type TEXT CHECK (owner_type IN ('User', 'Organization'));
ALTER TABLE repos ADD COLUMN owner_login TEXT;
ALTER TABLE repos ADD COLUMN default_branch TEXT;
CREATE INDEX repos_installation ON repos (installation_id);

-- last_webhook_at, last_reconcile_at, last_reconcile_corrections (its count in detail).
CREATE TABLE sync_state (
  name TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  detail TEXT
);

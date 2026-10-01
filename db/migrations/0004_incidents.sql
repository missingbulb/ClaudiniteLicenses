-- One row per occurrence of a marker the alerts count in a window, so a windowed count is built
-- only from what happened inside the window. The key Worker's markers arrive on the writes queue;
-- the sync Worker writes its own directly and prunes rows older than any alert window.

CREATE TABLE incidents (
  id INTEGER PRIMARY KEY,
  marker TEXT NOT NULL,
  at INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX incidents_marker_at ON incidents (marker, at);

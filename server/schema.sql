CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_name TEXT,
  stored_path TEXT,
  file_hash TEXT,
  year INTEGER,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER,
  name TEXT NOT NULL,
  workplace TEXT,
  position TEXT,
  course TEXT,
  year INTEGER NOT NULL,
  period TEXT,
  date_start TEXT,
  date_end TEXT,
  district TEXT,
  org_type TEXT,
  import_id INTEGER REFERENCES imports(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_registry_year ON registry(year);
CREATE INDEX IF NOT EXISTS idx_registry_course ON registry(course);
CREATE INDEX IF NOT EXISTS idx_registry_name ON registry(name);

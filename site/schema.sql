-- Waitlist for agenthuddle.net (D1 database "agenthuddle-site").
CREATE TABLE IF NOT EXISTS waitlist (email TEXT PRIMARY KEY, created INTEGER NOT NULL, country TEXT, source TEXT);
CREATE TABLE IF NOT EXISTS hits (ip TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS hits_ip ON hits(ip, ts);

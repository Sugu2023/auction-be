-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  logo        TEXT NOT NULL,
  owner       TEXT NOT NULL,
  captain     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('Batsman', 'Bowler', 'All-rounder', 'Keeper')),
  base_price  INTEGER NOT NULL CHECK (base_price > 0),
  phone       TEXT,
  -- Either a URL/path, or the image itself as a base64 data URL.
  photo       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin', 'team')),
  team_id        TEXT REFERENCES teams(id) ON DELETE SET NULL
);

-- One row per player who has been sold. A player can be sold only once.
CREATE TABLE IF NOT EXISTS sales (
  player_id  TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  price      INTEGER NOT NULL CHECK (price > 0),
  sold_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

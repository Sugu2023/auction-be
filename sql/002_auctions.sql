-- Each auction has its own teams, players and live state.

CREATE TABLE IF NOT EXISTS auctions (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  total_teams    INTEGER NOT NULL CHECK (total_teams >= 1),
  base_purse     INTEGER NOT NULL CHECK (base_purse >= 1),
  bid_increment  INTEGER NOT NULL CHECK (bid_increment >= 1),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Existing teams and players belong to the first auction.
INSERT INTO auctions (id, name, total_teams, base_purse, bid_increment)
VALUES ('auction-1', 'Elandhai Premier League', 3, 1000, 10)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE teams ADD COLUMN IF NOT EXISTS auction_id TEXT REFERENCES auctions(id) ON DELETE CASCADE;
UPDATE teams SET auction_id = 'auction-1' WHERE auction_id IS NULL;
ALTER TABLE teams ALTER COLUMN auction_id SET NOT NULL;
-- Team names only need to be unique within one auction.
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_name_key;
ALTER TABLE teams ADD CONSTRAINT teams_auction_name_key UNIQUE (auction_id, name);

ALTER TABLE players ADD COLUMN IF NOT EXISTS auction_id TEXT REFERENCES auctions(id) ON DELETE CASCADE;
UPDATE players SET auction_id = 'auction-1' WHERE auction_id IS NULL;
ALTER TABLE players ALTER COLUMN auction_id SET NOT NULL;

-- The live auction for each auction: which set is running, who is on the block, the bid.
CREATE TABLE IF NOT EXISTS auction_live (
  auction_id          TEXT PRIMARY KEY REFERENCES auctions(id) ON DELETE CASCADE,
  category            TEXT,
  queue               TEXT[] NOT NULL DEFAULT '{}',
  current_player_id   TEXT REFERENCES players(id) ON DELETE SET NULL,
  current_bid         INTEGER NOT NULL DEFAULT 0,
  current_bid_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  unsold              TEXT[] NOT NULL DEFAULT '{}'
);

INSERT INTO auction_live (auction_id) VALUES ('auction-1') ON CONFLICT DO NOTHING;

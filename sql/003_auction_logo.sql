-- Optional logo for each auction, stored as a base64 data URL (PNG or JPEG).
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS logo TEXT;

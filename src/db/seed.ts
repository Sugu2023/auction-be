import bcrypt from 'bcryptjs';
import { pool } from '../db.js';

// Starting data for a fresh database: one auction with its teams, players and logins.
// Inserts only rows that don't exist yet, so it is safe to re-run.
// Passwords are stored as bcrypt hashes, never as plain text.

const auctionId = 'auction-1';

const auction = { id: auctionId, name: 'Elandhai Premier League', totalTeams: 3, basePurse: 1000, bidIncrement: 10 };

const teams = [
  { id: 'team-yellow-titans', name: 'Elandhai Super Kings', logo: '/logos/yellow-titans.svg', owner: 'Thirumurugan', captain: 'Sugumaran' },
  { id: 'team-navy-strikers', name: 'Elandhai Titans', logo: '/logos/navy-strikers.svg', owner: 'Ajith', captain: 'Rishi' },
  { id: 'team-golden-gladiators', name: 'Elandhai Paltans', logo: '/logos/golden-gladiators.svg', owner: 'Prasanna', captain: 'Krishna' },
];

const players = [
  { id: 'p1', name: 'Palani', category: 'Batsman', basePrice: 100, phone: '7094317136', photo: '/players/palani.jpeg' },
  { id: 'p2', name: 'Sarathy', category: 'Bowler', basePrice: 100, phone: null, photo: '/players/p2.svg' },
  { id: 'p3', name: 'Siva', category: 'All-rounder', basePrice: 100, phone: null, photo: '/players/p3.svg' },
  { id: 'p4', name: 'Sanjay', category: 'Keeper', basePrice: 100, phone: null, photo: '/players/p4.svg' },
  { id: 'p5', name: 'Bhavan', category: 'Batsman', basePrice: 100, phone: null, photo: '/players/p5.svg' },
  { id: 'p6', name: 'Thiru', category: 'Batsman', basePrice: 100, phone: '9361754056', photo: '/players/p5.svg' },
];

const users = [
  { username: 'admin', password: 'admin123', role: 'admin', teamId: null },
  { username: 'yellow', password: 'yellow123', role: 'team', teamId: 'team-yellow-titans' },
  { username: 'navy', password: 'navy123', role: 'team', teamId: 'team-navy-strikers' },
  { username: 'gold', password: 'gold123', role: 'team', teamId: 'team-golden-gladiators' },
];

const client = await pool.connect();
try {
  await client.query('BEGIN');

  await client.query(
    `INSERT INTO auctions (id, name, total_teams, base_purse, bid_increment) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [auction.id, auction.name, auction.totalTeams, auction.basePurse, auction.bidIncrement],
  );
  await client.query('INSERT INTO auction_live (auction_id) VALUES ($1) ON CONFLICT DO NOTHING', [auctionId]);

  for (const t of teams) {
    await client.query(
      `INSERT INTO teams (id, auction_id, name, logo, owner, captain) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [t.id, auctionId, t.name, t.logo, t.owner, t.captain],
    );
  }

  for (const p of players) {
    await client.query(
      `INSERT INTO players (id, auction_id, name, category, base_price, phone, photo)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
      [p.id, auctionId, p.name, p.category, p.basePrice, p.phone, p.photo],
    );
  }

  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 10);
    await client.query(
      `INSERT INTO users (username, password_hash, role, team_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO NOTHING`,
      [u.username, hash, u.role, u.teamId],
    );
  }

  await client.query('COMMIT');
  console.log('Seed data inserted.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}

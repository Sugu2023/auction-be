import Boom from '@hapi/boom';
import type { PoolClient } from 'pg';
import { pool } from '../db.js';
import type { Category } from '../types.js';

// ---- Shapes sent to the React app -------------------------------------------

export interface AuctionConfig {
  id: string;
  name: string;
  totalTeams: number;
  basePurse: number;
  bidIncrement: number;
  logo: string | null;
}

export interface TeamDto {
  id: string;
  name: string;
  logo: string;
  owner: string;
  captain: string;
}

export interface PlayerDto {
  id: string;
  name: string;
  category: Category;
  basePrice: number;
  phone?: string;
  photo?: string;
}

export interface SaleDto {
  playerId: string;
  teamId: string;
  price: number;
}

export interface LiveDto {
  category: Category | null;
  queue: string[];
  currentPlayerId: string | null;
  currentBid: number;
  currentBidTeamId: string | null;
  unsold: string[];
}

export interface AuctionState {
  config: AuctionConfig;
  teams: TeamDto[];
  players: PlayerDto[];
  sales: SaleDto[];
  live: LiveDto;
}

// ---- Database rows ----------------------------------------------------------

interface AuctionRow {
  id: string;
  name: string;
  total_teams: number;
  base_purse: number;
  bid_increment: number;
  logo: string | null;
}

interface TeamRow {
  id: string;
  name: string;
  logo: string;
  owner: string;
  captain: string;
}

interface PlayerRow {
  id: string;
  name: string;
  category: Category;
  base_price: number;
  phone: string | null;
  photo: string | null;
}

interface SaleRow {
  player_id: string;
  team_id: string;
  price: number;
}

interface LiveRow {
  category: Category | null;
  queue: string[];
  current_player_id: string | null;
  current_bid: number;
  current_bid_team_id: string | null;
  unsold: string[];
}

const toConfig = (r: AuctionRow): AuctionConfig => ({
  id: r.id,
  name: r.name,
  totalTeams: r.total_teams,
  basePurse: r.base_purse,
  bidIncrement: r.bid_increment,
  logo: r.logo,
});

const toTeam = (r: TeamRow): TeamDto => ({ ...r });

const toPlayer = (r: PlayerRow): PlayerDto => ({
  id: r.id,
  name: r.name,
  category: r.category,
  basePrice: r.base_price,
  phone: r.phone ?? undefined,
  photo: r.photo ?? undefined,
});

const toLive = (r: LiveRow): LiveDto => ({
  category: r.category,
  queue: r.queue,
  currentPlayerId: r.current_player_id,
  currentBid: r.current_bid,
  currentBidTeamId: r.current_bid_team_id,
  unsold: r.unsold,
});

// ---- Reads ------------------------------------------------------------------

export async function findAuction(id: string): Promise<AuctionConfig> {
  const { rows } = await pool.query<AuctionRow>(
    'SELECT id, name, total_teams, base_purse, bid_increment, logo FROM auctions WHERE id = $1',
    [id],
  );
  if (!rows[0]) throw Boom.notFound('Auction not found');
  return toConfig(rows[0]);
}

export async function listAuctions(): Promise<AuctionConfig[]> {
  const { rows } = await pool.query<AuctionRow>(
    'SELECT id, name, total_teams, base_purse, bid_increment, logo FROM auctions ORDER BY created_at, name',
  );
  return rows.map(toConfig);
}

export async function getAuctionState(id: string): Promise<AuctionState> {
  const config = await findAuction(id);
  const [teams, players, sales, live] = await Promise.all([
    pool.query<TeamRow>(
      'SELECT id, name, logo, owner, captain FROM teams WHERE auction_id = $1 ORDER BY created_at, name',
      [id],
    ),
    pool.query<PlayerRow>(
      'SELECT id, name, category, base_price, phone, photo FROM players WHERE auction_id = $1 ORDER BY created_at, name',
      [id],
    ),
    pool.query<SaleRow>(
      `SELECT s.player_id, s.team_id, s.price FROM sales s
       JOIN players p ON p.id = s.player_id WHERE p.auction_id = $1 ORDER BY s.sold_at`,
      [id],
    ),
    pool.query<LiveRow>(
      `SELECT category, queue, current_player_id, current_bid, current_bid_team_id, unsold
       FROM auction_live WHERE auction_id = $1`,
      [id],
    ),
  ]);

  return {
    config,
    teams: teams.rows.map(toTeam),
    players: players.rows.map(toPlayer),
    sales: sales.rows.map(r => ({ playerId: r.player_id, teamId: r.team_id, price: r.price })),
    live: toLive(live.rows[0]),
  };
}

/** Once an auction has a sale or a live set, its teams, players and settings are fixed. */
export async function isLocked(id: string): Promise<boolean> {
  const { rows } = await pool.query<{ locked: boolean }>(
    `SELECT (l.category IS NOT NULL OR cardinality(l.unsold) > 0
             OR EXISTS (SELECT 1 FROM sales s JOIN players p ON p.id = s.player_id WHERE p.auction_id = $1)) AS locked
     FROM auction_live l WHERE l.auction_id = $1`,
    [id],
  );
  return rows[0]?.locked ?? false;
}

// ---- Live auction -----------------------------------------------------------

interface LiveContext {
  client: PoolClient;
  auctionId: string;
  config: AuctionConfig;
  live: LiveDto;
}

function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

async function purseOf(ctx: LiveContext, teamId: string): Promise<number> {
  const { rows } = await ctx.client.query<{ spent: string }>(
    `SELECT COALESCE(SUM(s.price), 0) AS spent FROM sales s
     JOIN players p ON p.id = s.player_id WHERE p.auction_id = $1 AND s.team_id = $2`,
    [ctx.auctionId, teamId],
  );
  return ctx.config.basePurse - Number(rows[0].spent);
}

/** Puts the next player from the queue on the block, or clears the block when the queue is empty. */
async function putNextOnBlock(ctx: LiveContext, queue: string[]) {
  const [nextId, ...rest] = queue;
  ctx.live.queue = rest;
  ctx.live.currentBidTeamId = null;
  if (!nextId) {
    ctx.live.currentPlayerId = null;
    ctx.live.currentBid = 0;
    return;
  }
  const { rows } = await ctx.client.query<{ base_price: number }>(
    'SELECT base_price FROM players WHERE id = $1 AND auction_id = $2',
    [nextId, ctx.auctionId],
  );
  ctx.live.currentPlayerId = nextId;
  ctx.live.currentBid = rows[0]?.base_price ?? 0;
}

async function startCategory(ctx: LiveContext, category: Category) {
  if (ctx.live.currentPlayerId) throw Boom.conflict('A player is already on the block.');

  const { rows: teamRows } = await ctx.client.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM teams WHERE auction_id = $1',
    [ctx.auctionId],
  );
  if (Number(teamRows[0].count) !== ctx.config.totalTeams) {
    throw Boom.conflict(`Add all ${ctx.config.totalTeams} teams before starting.`);
  }

  // Players not sold yet in this category: fresh ones first, then unsold ones for the re-auction.
  const { rows } = await ctx.client.query<{ id: string }>(
    `SELECT p.id FROM players p
     WHERE p.auction_id = $1 AND p.category = $2
       AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.player_id = p.id)`,
    [ctx.auctionId, category],
  );
  const pending = rows.map(r => r.id);
  const fresh = pending.filter(id => !ctx.live.unsold.includes(id));
  const unsold = pending.filter(id => ctx.live.unsold.includes(id));
  const queue = [...shuffle(fresh), ...shuffle(unsold)];
  if (queue.length === 0) throw Boom.conflict(`No players waiting in ${category}.`);

  ctx.live.category = category;
  await putNextOnBlock(ctx, queue);
}

async function bid(ctx: LiveContext, teamId: string) {
  if (!ctx.live.currentPlayerId) throw Boom.conflict('No player is on the block.');
  if (ctx.live.currentBidTeamId === teamId) throw Boom.badRequest('This team already holds the bid.');

  const { rows } = await ctx.client.query('SELECT 1 FROM teams WHERE id = $1 AND auction_id = $2', [
    teamId,
    ctx.auctionId,
  ]);
  if (!rows.length) throw Boom.badRequest('Unknown team.');

  // First bid is the base price; every raise after that adds the increment.
  const amount = ctx.live.currentBidTeamId
    ? ctx.live.currentBid + ctx.config.bidIncrement
    : ctx.live.currentBid;
  if ((await purseOf(ctx, teamId)) < amount) throw Boom.badRequest('This team does not have enough purse left.');

  ctx.live.currentBid = amount;
  ctx.live.currentBidTeamId = teamId;
}

async function resetBid(ctx: LiveContext) {
  if (!ctx.live.currentPlayerId) return;
  const { rows } = await ctx.client.query<{ base_price: number }>('SELECT base_price FROM players WHERE id = $1', [
    ctx.live.currentPlayerId,
  ]);
  ctx.live.currentBid = rows[0]?.base_price ?? 0;
  ctx.live.currentBidTeamId = null;
}

async function sold(ctx: LiveContext) {
  const { currentPlayerId, currentBidTeamId, currentBid } = ctx.live;
  if (!currentPlayerId || !currentBidTeamId) throw Boom.conflict('Only a player with a bid can be sold.');

  await ctx.client.query('INSERT INTO sales (player_id, team_id, price) VALUES ($1, $2, $3)', [
    currentPlayerId,
    currentBidTeamId,
    currentBid,
  ]);
  ctx.live.unsold = ctx.live.unsold.filter(id => id !== currentPlayerId);
  await putNextOnBlock(ctx, ctx.live.queue);
}

async function unsold(ctx: LiveContext) {
  const { currentPlayerId } = ctx.live;
  if (!currentPlayerId) throw Boom.conflict('No player is on the block.');
  // A player with a bid on the table must be sold, not passed.
  if (ctx.live.currentBidTeamId) throw Boom.conflict('A bid has been placed, so this player must be sold.');

  if (!ctx.live.unsold.includes(currentPlayerId)) ctx.live.unsold = [...ctx.live.unsold, currentPlayerId];
  await putNextOnBlock(ctx, ctx.live.queue);
}

function endCategory(ctx: LiveContext) {
  ctx.live.category = null;
  ctx.live.queue = [];
  ctx.live.currentPlayerId = null;
  ctx.live.currentBid = 0;
  ctx.live.currentBidTeamId = null;
}

export type LiveAction =
  | { type: 'start'; category: Category }
  | { type: 'bid'; teamId: string }
  | { type: 'resetBid' }
  | { type: 'sold' }
  | { type: 'unsold' }
  | { type: 'endCategory' };

/**
 * Runs one live-auction action inside a transaction. The live row is locked
 * (FOR UPDATE) so two admins clicking at once can't both win the same bid.
 */
export async function runLiveAction(auctionId: string, action: LiveAction): Promise<AuctionState> {
  const config = await findAuction(auctionId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<LiveRow>(
      `SELECT category, queue, current_player_id, current_bid, current_bid_team_id, unsold
       FROM auction_live WHERE auction_id = $1 FOR UPDATE`,
      [auctionId],
    );
    const ctx: LiveContext = { client, auctionId, config, live: toLive(rows[0]) };

    switch (action.type) {
      case 'start':
        await startCategory(ctx, action.category);
        break;
      case 'bid':
        await bid(ctx, action.teamId);
        break;
      case 'resetBid':
        await resetBid(ctx);
        break;
      case 'sold':
        await sold(ctx);
        break;
      case 'unsold':
        await unsold(ctx);
        break;
      case 'endCategory':
        endCategory(ctx);
        break;
    }

    await client.query(
      `UPDATE auction_live SET category = $2, queue = $3, current_player_id = $4, current_bid = $5,
         current_bid_team_id = $6, unsold = $7 WHERE auction_id = $1`,
      [
        auctionId,
        ctx.live.category,
        ctx.live.queue,
        ctx.live.currentPlayerId,
        ctx.live.currentBid,
        ctx.live.currentBidTeamId,
        ctx.live.unsold,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return getAuctionState(auctionId);
}

/** Clears every sale and the live position, but keeps teams and players. */
export async function resetSales(auctionId: string): Promise<AuctionState> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM sales WHERE player_id IN (SELECT id FROM players WHERE auction_id = $1)',
      [auctionId],
    );
    await client.query(
      `UPDATE auction_live SET category = NULL, queue = '{}', current_player_id = NULL,
         current_bid = 0, current_bid_team_id = NULL, unsold = '{}' WHERE auction_id = $1`,
      [auctionId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return getAuctionState(auctionId);
}

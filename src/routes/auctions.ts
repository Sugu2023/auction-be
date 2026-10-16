import Boom from '@hapi/boom';
import type { Request, ServerRoute } from '@hapi/hapi';
import bcrypt from 'bcryptjs';
import Joi from 'joi';
import { randomUUID } from 'node:crypto';
import { getCredentials, requireAdmin } from '../auth.js';
import { pool } from '../db.js';
import {
  findAuction,
  getAuctionState,
  isLocked,
  listAuctions,
  resetSales,
  runLiveAction,
  type AuctionState,
} from '../services/auctions.js';
import { CATEGORIES, type Category, type Credentials } from '../types.js';

// Images arrive as base64 data URLs (or as a path for the seeded players).
const IMAGE_PATTERN = /^(data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+|\/[^\s]*)$/;

const auctionPayload = Joi.object({
  name: Joi.string().trim().min(1).max(80).required(),
  totalTeams: Joi.number().integer().min(1).max(20).required(),
  basePurse: Joi.number().integer().min(1).max(1_000_000_000).required(),
  bidIncrement: Joi.number().integer().min(1).max(1_000_000).required(),
  // Optional PNG or JPEG logo as a base64 data URL. Omit it to keep the current logo.
  logo: Joi.string().max(8_000_000).pattern(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/).allow('', null),
});

const teamPayload = Joi.object({
  name: Joi.string().trim().min(1).max(60).required(),
  owner: Joi.string().trim().min(1).max(60).required(),
  captain: Joi.string().trim().min(1).max(60).required(),
  logo: Joi.string().max(8_000_000).pattern(IMAGE_PATTERN).allow('', null),
  // Login for the team's own page.
  username: Joi.string().trim().alphanum().min(3).max(30).required(),
  password: Joi.string().min(6).max(100).required(),
});

const playerPayload = Joi.object({
  name: Joi.string().trim().min(1).max(60).required(),
  category: Joi.string().valid(...CATEGORIES).required(),
  basePrice: Joi.number().integer().min(1).max(10_000_000).required(),
  phone: Joi.string().trim().pattern(/^\d{10,13}$/).allow('', null),
  photo: Joi.string().max(8_000_000).pattern(IMAGE_PATTERN).allow('', null),
});

/** Admins can open any auction; a team login can open only the auction its team is in. */
async function assertCanView(credentials: Credentials, auctionId: string) {
  if (credentials.role === 'admin') return;
  if (!credentials.teamId) throw Boom.forbidden();
  const { rows } = await pool.query('SELECT 1 FROM teams WHERE id = $1 AND auction_id = $2', [
    credentials.teamId,
    auctionId,
  ]);
  if (!rows.length) throw Boom.forbidden('Your team is not part of this auction.');
}

/** Teams, players and settings can't change once the auction has started. */
async function assertNotLocked(auctionId: string) {
  if (await isLocked(auctionId)) {
    throw Boom.conflict('The auction has started, so this cannot be changed.');
  }
}

const idParam = (request: Request, name: string): string => String(request.params[name]);

export const auctionRoutes: ServerRoute[] = [
  // ---- Auctions -------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/auctions',
    handler: async request => {
      const credentials = getCredentials(request);
      if (credentials.role === 'admin') return listAuctions();
      if (!credentials.teamId) return [];
      const { rows } = await pool.query(
        `SELECT a.id, a.name, a.total_teams, a.base_purse, a.bid_increment, a.logo
         FROM auctions a JOIN teams t ON t.auction_id = a.id WHERE t.id = $1`,
        [credentials.teamId],
      );
      return rows.map(r => ({
        id: r.id,
        name: r.name,
        totalTeams: r.total_teams,
        basePurse: r.base_purse,
        bidIncrement: r.bid_increment,
        logo: r.logo,
      }));
    },
  },
  {
    method: 'POST',
    path: '/api/auctions',
    options: { validate: { payload: auctionPayload } },
    handler: async (request, h) => {
      requireAdmin(request);
      const body = request.payload as {
        name: string;
        totalTeams: number;
        basePurse: number;
        bidIncrement: number;
        logo?: string | null;
      };
      const id = `auction-${randomUUID()}`;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'INSERT INTO auctions (id, name, total_teams, base_purse, bid_increment, logo) VALUES ($1, $2, $3, $4, $5, $6)',
          [id, body.name, body.totalTeams, body.basePurse, body.bidIncrement, body.logo || null],
        );
        await client.query('INSERT INTO auction_live (auction_id) VALUES ($1)', [id]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return h.response(await getAuctionState(id)).code(201);
    },
  },
  {
    method: 'GET',
    path: '/api/auctions/{id}/state',
    handler: async request => {
      const auctionId = idParam(request, 'id');
      await assertCanView(getCredentials(request), auctionId);
      return getAuctionState(auctionId);
    },
  },
  {
    method: 'PUT',
    path: '/api/auctions/{id}',
    options: { validate: { payload: auctionPayload } },
    handler: async request => {
      requireAdmin(request);
      const auctionId = idParam(request, 'id');
      await findAuction(auctionId);
      await assertNotLocked(auctionId);

      const body = request.payload as {
        name: string;
        totalTeams: number;
        basePurse: number;
        bidIncrement: number;
        logo?: string | null;
      };
      const { rows } = await pool.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM teams WHERE auction_id = $1',
        [auctionId],
      );
      if (body.totalTeams < Number(rows[0].count)) {
        throw Boom.badRequest(`${rows[0].count} teams are already added. Set the number of teams to at least that.`);
      }

      await pool.query(
        `UPDATE auctions SET name = $2, total_teams = $3, base_purse = $4, bid_increment = $5,
           logo = COALESCE($6, logo) WHERE id = $1`,
        [auctionId, body.name, body.totalTeams, body.basePurse, body.bidIncrement, body.logo || null],
      );
      return getAuctionState(auctionId);
    },
  },
  {
    method: 'DELETE',
    path: '/api/auctions/{id}',
    handler: async (request, h) => {
      requireAdmin(request);
      const auctionId = idParam(request, 'id');
      await findAuction(auctionId);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Team logins are not deleted by the cascade, so remove them explicitly.
        await client.query(
          'DELETE FROM users WHERE team_id IN (SELECT id FROM teams WHERE auction_id = $1)',
          [auctionId],
        );
        await client.query('DELETE FROM auctions WHERE id = $1', [auctionId]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return h.response().code(204);
    },
  },

  // ---- Teams ----------------------------------------------------------------
  {
    method: 'POST',
    path: '/api/auctions/{id}/teams',
    options: { validate: { payload: teamPayload } },
    handler: async request => {
      requireAdmin(request);
      const auctionId = idParam(request, 'id');
      const config = await findAuction(auctionId);
      await assertNotLocked(auctionId);

      const body = request.payload as {
        name: string;
        owner: string;
        captain: string;
        logo?: string | null;
        username: string;
        password: string;
      };
      const { rows } = await pool.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM teams WHERE auction_id = $1',
        [auctionId],
      );
      if (Number(rows[0].count) >= config.totalTeams) {
        throw Boom.conflict(`All ${config.totalTeams} teams are already added.`);
      }

      const passwordHash = await bcrypt.hash(body.password, 10);
      const teamId = `team-${randomUUID()}`;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'INSERT INTO teams (id, auction_id, name, logo, owner, captain) VALUES ($1, $2, $3, $4, $5, $6)',
          [teamId, auctionId, body.name, body.logo || '/logos/default.svg', body.owner, body.captain],
        );
        await client.query(
          `INSERT INTO users (username, password_hash, role, team_id) VALUES ($1, $2, 'team', $3)`,
          [body.username.toLowerCase(), passwordHash, teamId],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        const constraint = (error as { constraint?: string }).constraint;
        if (constraint === 'teams_auction_name_key') throw Boom.conflict('A team with this name already exists.');
        if (constraint === 'users_username_key') throw Boom.conflict('That username is already taken.');
        throw error;
      } finally {
        client.release();
      }
      return getAuctionState(auctionId);
    },
  },
  {
    method: 'DELETE',
    path: '/api/auctions/{id}/teams/{teamId}',
    handler: async request => {
      requireAdmin(request);
      const auctionId = idParam(request, 'id');
      const teamId = idParam(request, 'teamId');
      await findAuction(auctionId);
      await assertNotLocked(auctionId);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM users WHERE team_id = $1', [teamId]);
        const { rowCount } = await client.query('DELETE FROM teams WHERE id = $1 AND auction_id = $2', [
          teamId,
          auctionId,
        ]);
        if (!rowCount) throw Boom.notFound('Team not found');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return getAuctionState(auctionId);
    },
  },

  // ---- Players --------------------------------------------------------------
  {
    method: 'POST',
    path: '/api/auctions/{id}/players',
    options: { validate: { payload: playerPayload } },
    handler: async request => {
      requireAdmin(request);
      const auctionId = idParam(request, 'id');
      await findAuction(auctionId);
      await assertNotLocked(auctionId);

      const body = request.payload as {
        name: string;
        category: Category;
        basePrice: number;
        phone?: string | null;
        photo?: string | null;
      };
      await pool.query(
        `INSERT INTO players (id, auction_id, name, category, base_price, phone, photo)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          `player-${randomUUID()}`,
          auctionId,
          body.name,
          body.category,
          body.basePrice,
          body.phone || null,
          body.photo || null,
        ],
      );
      return getAuctionState(auctionId);
    },
  },
  {
    method: 'DELETE',
    path: '/api/auctions/{id}/players/{playerId}',
    handler: async request => {
      requireAdmin(request);
      const auctionId = idParam(request, 'id');
      await findAuction(auctionId);
      await assertNotLocked(auctionId);

      const { rowCount } = await pool.query('DELETE FROM players WHERE id = $1 AND auction_id = $2', [
        idParam(request, 'playerId'),
        auctionId,
      ]);
      if (!rowCount) throw Boom.notFound('Player not found');
      return getAuctionState(auctionId);
    },
  },
  {
    // Deletes every player in the auction. Their sales go too, and the live auction is cleared.
    method: 'DELETE',
    path: '/api/auctions/{id}/players',
    handler: async request => {
      requireAdmin(request);
      const auctionId = idParam(request, 'id');
      await findAuction(auctionId);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM players WHERE auction_id = $1', [auctionId]);
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
    },
  },

  // ---- Live auction ---------------------------------------------------------
  {
    method: 'POST',
    path: '/api/auctions/{id}/live/start',
    options: {
      validate: { payload: Joi.object({ category: Joi.string().valid(...CATEGORIES).required() }) },
    },
    handler: async request => {
      requireAdmin(request);
      const { category } = request.payload as { category: Category };
      return runLiveAction(idParam(request, 'id'), { type: 'start', category });
    },
  },
  {
    method: 'POST',
    path: '/api/auctions/{id}/live/bid',
    options: { validate: { payload: Joi.object({ teamId: Joi.string().required() }) } },
    handler: async request => {
      requireAdmin(request);
      const { teamId } = request.payload as { teamId: string };
      return runLiveAction(idParam(request, 'id'), { type: 'bid', teamId });
    },
  },
  {
    method: 'POST',
    path: '/api/auctions/{id}/live/reset-bid',
    handler: async request => {
      requireAdmin(request);
      return runLiveAction(idParam(request, 'id'), { type: 'resetBid' });
    },
  },
  {
    method: 'POST',
    path: '/api/auctions/{id}/live/sold',
    handler: async request => {
      requireAdmin(request);
      return runLiveAction(idParam(request, 'id'), { type: 'sold' });
    },
  },
  {
    method: 'POST',
    path: '/api/auctions/{id}/live/unsold',
    handler: async request => {
      requireAdmin(request);
      return runLiveAction(idParam(request, 'id'), { type: 'unsold' });
    },
  },
  {
    method: 'POST',
    path: '/api/auctions/{id}/live/end-category',
    handler: async request => {
      requireAdmin(request);
      return runLiveAction(idParam(request, 'id'), { type: 'endCategory' });
    },
  },
  {
    // Clears every sale and the live position, so the auction can run again.
    method: 'POST',
    path: '/api/auctions/{id}/reset',
    handler: async request => {
      requireAdmin(request);
      const state: AuctionState = await resetSales(idParam(request, 'id'));
      return state;
    },
  },
];

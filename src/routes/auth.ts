import Boom from '@hapi/boom';
import type { ServerRoute } from '@hapi/hapi';
import Jwt from '@hapi/jwt';
import bcrypt from 'bcryptjs';
import Joi from 'joi';
import { config } from '../config.js';
import { pool } from '../db.js';
import { getCredentials } from '../auth.js';
import type { Credentials, Role } from '../types.js';

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  team_id: string | null;
}

export const authRoutes: ServerRoute[] = [
  {
    method: 'POST',
    path: '/api/auth/login',
    options: {
      auth: false,
      validate: {
        payload: Joi.object({
          username: Joi.string().required(),
          password: Joi.string().required(),
        }),
      },
    },
    handler: async request => {
      const { username, password } = request.payload as { username: string; password: string };

      const { rows } = await pool.query<UserRow>(
        'SELECT id, username, password_hash, role, team_id FROM users WHERE username = $1',
        [username.trim()],
      );
      const user = rows[0];
      // Same message for unknown user and wrong password, so usernames can't be guessed.
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        throw Boom.unauthorized('Invalid username or password');
      }

      const credentials: Credentials = {
        id: user.id,
        username: user.username,
        role: user.role,
        teamId: user.team_id,
      };
      const token = Jwt.token.generate(
        { ...credentials, iat: Math.floor(Date.now() / 1000) },
        { key: config.jwtSecret, algorithm: 'HS256' },
      );

      return { token, user: credentials };
    },
  },
  {
    method: 'GET',
    path: '/api/auth/me',
    handler: request => getCredentials(request),
  },
];

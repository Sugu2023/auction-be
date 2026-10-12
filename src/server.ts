import Hapi from '@hapi/hapi';
import Jwt from '@hapi/jwt';
import { config } from './config.js';
import { pool } from './db.js';
import { authRoutes } from './routes/auth.js';
import { auctionRoutes } from './routes/auctions.js';

const server = Hapi.server({
  port: config.port,
  host: 'localhost',
  routes: {
    // Large enough for a base64 photo (the image is sent inside the JSON body).
    payload: { maxBytes: 10 * 1024 * 1024 },
  },
});

await server.register(Jwt);

server.auth.strategy('jwt', 'jwt', {
  keys: config.jwtSecret,
  verify: {
    aud: false,
    iss: false,
    sub: false,
    nbf: true,
    exp: true,
    maxAgeSec: config.tokenMaxAgeSeconds,
    timeSkewSec: 15,
  },
  validate: async artifacts => {
    const payload = artifacts.decoded.payload as Record<string, unknown>;
    return {
      isValid: true,
      credentials: {
        id: payload.id,
        username: payload.username,
        role: payload.role,
        teamId: payload.teamId ?? null,
      },
    };
  },
});

// Every route needs a valid token unless it sets auth: false (login does).
server.auth.default('jwt');

server.route([...authRoutes, ...auctionRoutes]);

server.events.on('stop', () => {
  void pool.end();
});

await server.start();
console.log(`API running at ${server.info.uri}`);

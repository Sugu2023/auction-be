import Boom from '@hapi/boom';
import type { Request } from '@hapi/hapi';
import type { Credentials } from './types.js';

export function getCredentials(request: Request): Credentials {
  return request.auth.credentials as unknown as Credentials;
}

export function requireAdmin(request: Request): void {
  if (getCredentials(request).role !== 'admin') {
    throw Boom.forbidden('Only the admin can do this.');
  }
}

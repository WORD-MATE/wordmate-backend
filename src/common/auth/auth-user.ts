import type { Role } from '../enums.js';

export interface AuthUser {
  userId: string;
  role: Role;
  isAdmin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

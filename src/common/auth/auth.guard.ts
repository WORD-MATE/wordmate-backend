import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { CommonErrors } from '../errors/app-exception.js';
import { AUTH_KEY, type Authority } from './auth.decorator.js';
import type { AuthUser } from './auth-user.js';

const allows: Record<Exclude<Authority, 'ALL'>, (user: AuthUser) => boolean> = {
  USER: () => true,
  STUDENT: (user) => user.role === 'STUDENT',
  TEACHER: (user) => user.role === 'TEACHER',
  ADMIN: (user) => user.isAdmin,
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const authorities = this.reflector.getAllAndOverride<Authority[] | undefined>(AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? ['USER'];

    if (authorities.includes('ALL')) return true;

    const { user } = context.switchToHttp().getRequest<FastifyRequest>();
    if (!user) throw CommonErrors.unauthorized();

    const permitted = authorities.some(
      (authority) => authority !== 'ALL' && allows[authority](user),
    );
    if (!permitted) throw CommonErrors.forbidden();
    return true;
  }
}

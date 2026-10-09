import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config/env.js';
import { Errors } from './errorHandler.js';
import { AuthService, type AccessTokenClaims } from '../services/authService.js';
import { parseDbId } from '../utils/ids.js';

/**
 * Verifies the JWT access token, then confirms its login session is still
 * active in the database, and attaches that session's user to req.user.
 * This is the ONLY place request identity is established - every
 * downstream handler must read req.user, never req.body.userId,
 * req.query.userId, or a route param, for "who is making this request".
 */
export async function authenticateToken(req: Request, _res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      throw Errors.unauthorized();
    }

    let claims: AccessTokenClaims;
    try {
      claims = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] }) as AccessTokenClaims;
    } catch {
      throw Errors.unauthorized();
    }
    if (!Number.isInteger(claims.sid) || !Number.isInteger(claims.id)) {
      throw Errors.unauthorized();
    }

    const user = await AuthService.resolveSession(claims.sid, claims.id);
    if (!user) {
      throw Errors.unauthorized();
    }
    req.user = user;
    req.sessionId = claims.sid;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Confirms a request is authenticated at all. Mostly used for clarity at
 * the top of a router - authenticateToken already guarantees req.user is
 * set, but this gives call sites an explicit, readable check.
 */
export function requireUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    throw Errors.unauthorized();
  }
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    throw Errors.unauthorized();
  }

  if (req.user.role !== 'admin') {
    throw Errors.forbidden('Admin access required');
  }

  next();
}

/**
 * Authorizes access to a resource owned by a specific user, where that
 * user's id appears in the URL as req.params[paramName] (e.g. "/:userId").
 *
 * This does NOT use the URL to decide who is making the request - req.user
 * (set by authenticateToken from the verified JWT) remains the sole source
 * of caller identity. It only decides whether the authenticated caller is
 * allowed to see the resource named in the URL: either they own it
 * (req.user.id === the param) or they're an admin.
 */
export function requireSelfOrAdmin(paramName: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      throw Errors.unauthorized();
    }

    const targetId = parseDbId(req.params[paramName], paramName);

    if (req.user.role !== 'admin' && req.user.id !== targetId) {
      throw Errors.forbidden('You can only access your own data');
    }

    next();
  };
}

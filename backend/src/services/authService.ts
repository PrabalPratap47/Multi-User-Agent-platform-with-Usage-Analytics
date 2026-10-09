import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcryptjs from 'bcryptjs';
import prisma from '../db/client.js';
import config from '../config/env.js';
import { Errors } from '../middleware/errorHandler.js';
import { UserPayload, LoginRequest, LoginResponse } from '../types/index.js';
import logger from '../config/logging.js';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Brute-force protection: after this many failed logins for one email from
// one IP inside the window, further attempts are refused (429) until it ends.
const LOGIN_MAX_FAILURES = 10;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const failedLogins = new Map<string, { count: number; firstAt: number }>();

function loginThrottleKey(clientIp: string, email: string): string {
  return `${clientIp}|${email.trim().toLowerCase()}`;
}

function isLoginLocked(key: string, now: number): boolean {
  const entry = failedLogins.get(key);
  return !!entry && now - entry.firstAt < LOGIN_FAILURE_WINDOW_MS && entry.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(key: string, now: number): void {
  const entry = failedLogins.get(key);
  if (!entry || now - entry.firstAt >= LOGIN_FAILURE_WINDOW_MS) {
    failedLogins.set(key, { count: 1, firstAt: now });
  } else {
    entry.count += 1;
  }
  if (failedLogins.size > 10_000) {
    for (const [k, v] of failedLogins) if (now - v.firstAt >= LOGIN_FAILURE_WINDOW_MS) failedLogins.delete(k);
  }
}

/** Claims inside an access token. `sid` is the RefreshToken row id of the login session it belongs to. */
export interface AccessTokenClaims extends UserPayload {
  sid: number;
}

export function toPayload(user: { id: number; email: string; role: string }): UserPayload {
  // Prisma stores the Role enum as 'ADMIN' | 'USER'; the API/JWT contract
  // uses lowercase 'admin' | 'user'. This must be an actual runtime
  // conversion, not just a type assertion, or every role check downstream
  // silently compares against the wrong case.
  const role = user.role.toLowerCase();
  if (role !== 'admin' && role !== 'user') {
    throw new Error(`Unexpected role value from database: ${user.role}`);
  }
  return { id: user.id, email: user.email, role };
}

export class AuthService {
  /**
   * Issue a new opaque refresh token, persist only its hash, and return the
   * raw token to hand to the client. The raw value is never stored.
   */
  /**
   * Issue a new opaque refresh token (one login session), persist only its
   * hash, and return the raw token plus the session's row id.
   */
  private static async issueRefreshToken(userId: number): Promise<{ rawToken: string; sessionId: number }> {
    const rawToken = crypto.randomBytes(40).toString('hex');
    const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_EXPIRY_SECONDS * 1000);

    const session = await prisma.refreshToken.create({
      data: {
        tokenHash: hashToken(rawToken),
        userId,
        expiresAt,
      },
    });

    return { rawToken, sessionId: session.id };
  }

  private static signAccessToken(payload: UserPayload, sessionId: number): string {
    const claims: AccessTokenClaims = { ...payload, sid: sessionId };
    return jwt.sign(claims, config.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: config.JWT_EXPIRY_SECONDS,
    });
  }

  /**
   * The identity behind an access token, read from the database: the
   * session must exist, be unrevoked and unexpired, and belong to the user
   * named in the token. Returns null otherwise. The role comes from the
   * user row, so a role change or deleted account takes effect immediately.
   */
  static async resolveSession(sessionId: number, tokenUserId: number): Promise<UserPayload | null> {
    const session = await prisma.refreshToken.findUnique({
      where: { id: sessionId },
      include: { user: { select: { id: true, email: true, role: true } } },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.userId !== tokenUserId) {
      return null;
    }
    return toPayload(session.user);
  }

  /**
   * Login user and return a short-lived JWT access token plus an opaque
   * refresh token backed by a database record (so it can be revoked later).
   */
  static async login(request: LoginRequest, clientIp = 'unknown'): Promise<LoginResponse> {
    const { email, password } = request;
    const throttleKey = loginThrottleKey(clientIp, email);
    const now = Date.now();

    if (isLoginLocked(throttleKey, now)) {
      logger.warn('Login refused - too many failed attempts', { ip: clientIp });
      throw Errors.tooManyRequests('Too many failed login attempts. Try again in 15 minutes.');
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      recordLoginFailure(throttleKey, now);
      logger.warn('Failed login attempt - unknown email', { ip: clientIp });
      throw Errors.badRequest('Invalid email or password');
    }

    const passwordMatch = await bcryptjs.compare(password, user.password);
    if (!passwordMatch) {
      recordLoginFailure(throttleKey, now);
      logger.warn('Failed login attempt - wrong password', { userId: user.id, ip: clientIp });
      throw Errors.badRequest('Invalid email or password');
    }

    failedLogins.delete(throttleKey);
    const payload = toPayload(user);
    const { rawToken: refreshToken, sessionId } = await this.issueRefreshToken(user.id);
    const accessToken = this.signAccessToken(payload, sessionId);

    logger.info('User logged in', { userId: user.id, role: user.role });

    return { accessToken, refreshToken, user: payload };
  }

  /**
   * Exchange a valid, unexpired, unrevoked refresh token for a new access
   * token. The refresh token is rotated: the old one is revoked and a new
   * one issued. The user identity comes ONLY from the database row the
   * token hash resolves to - never from any client-supplied id.
   */
  static async refreshToken(
    rawRefreshToken: string
  ): Promise<{ accessToken: string; refreshToken: string }> {
    if (!rawRefreshToken) {
      throw Errors.unauthorized();
    }

    const tokenHash = hashToken(rawRefreshToken);

    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw Errors.unauthorized();
    }

    // Rotate: revoke the used token and issue a brand new one.
    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    // The old session is revoked above, so access tokens issued for it stop working.
    const payload = toPayload(stored.user);
    const { rawToken: newRefreshToken, sessionId } = await this.issueRefreshToken(stored.user.id);
    const accessToken = this.signAccessToken(payload, sessionId);

    return { accessToken, refreshToken: newRefreshToken };
  }

  /**
   * End the caller's current session (the one their access token belongs
   * to), plus the refresh token they sent if it is theirs. Both are scoped
   * to the authenticated user: someone else's token is simply not found.
   */
  static async logout(authenticatedUserId: number, sessionId?: number, rawRefreshToken?: string): Promise<void> {
    const sessionFilters = [
      ...(sessionId !== undefined ? [{ id: sessionId }] : []),
      ...(rawRefreshToken ? [{ tokenHash: hashToken(rawRefreshToken) }] : []),
    ];
    if (sessionFilters.length === 0) return;

    await prisma.refreshToken.updateMany({
      where: { userId: authenticatedUserId, revokedAt: null, OR: sessionFilters },
      data: { revokedAt: new Date() },
    });

    logger.info('User logged out', { userId: authenticatedUserId });
  }

  /**
   * Register a new user (admin-provisioning use case in this demo).
   */
  static async register(email: string, password: string, role: 'admin' | 'user' = 'user') {
    const existingUser = await prisma.user.findUnique({ where: { email } });

    if (existingUser) {
      throw Errors.conflict('User with this email already exists');
    }

    const passwordHash = await bcryptjs.hash(password, config.BCRYPT_SALT_ROUNDS);

    const user = await prisma.user.create({
      data: {
        email,
        password: passwordHash,
        role: role.toUpperCase() as 'ADMIN' | 'USER',
      },
    });

    logger.info('New user registered', { userId: user.id, email: user.email });

    return toPayload(user);
  }

  /**
   * Fetch the current authenticated user's profile, looked up fresh from
   * the database by the id extracted from the verified JWT. The caller
   * must never pass anything other than req.user.id here.
   */
  static async getCurrentUser(authenticatedUserId: number): Promise<UserPayload> {
    const user = await prisma.user.findUnique({
      where: { id: authenticatedUserId },
    });

    if (!user) {
      // Token was valid but the user no longer exists (e.g. deleted).
      throw Errors.unauthorized();
    }

    return toPayload(user);
  }
}

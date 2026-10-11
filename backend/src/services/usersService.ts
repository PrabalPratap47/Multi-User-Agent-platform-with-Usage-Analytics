import bcryptjs from 'bcryptjs';
import prisma from '../db/client.js';
import config from '../config/env.js';
import logger from '../config/logging.js';
import { Errors } from '../middleware/errorHandler.js';
import { UserPayload } from '../types/index.js';
import { validateChangePassword, validateCreateUser } from '../utils/validators.js';

/**
 * Admin user management (every route also requires an admin).
 *
 * "Delete" is a soft delete - deactivation. Every relation from `users`
 * cascades on a physical delete, which would erase the person's CVs,
 * decisions, sentiment results, agent runs and usage logs and silently
 * change historical analytics. A deactivated account keeps all of that, but
 * can no longer log in, refresh, or use any existing session
 * (AuthService.resolveSession / login / refreshToken), and all its sessions
 * are revoked. Its email stays reserved.
 */

const PUBLIC_FIELDS = { id: true, name: true, email: true, role: true, createdAt: true, deactivatedAt: true } as const;

type PublicUserRow = { id: number; name: string | null; email: string; role: string; createdAt: Date; deactivatedAt: Date | null };

/** Never the password hash, sessions or anything else sensitive. */
function toPublicUser(user: PublicUserRow) {
  return { ...user, role: user.role.toLowerCase(), status: user.deactivatedAt ? 'deactivated' : 'active' };
}

export class UsersService {
  static async list() {
    const users = await prisma.user.findMany({ select: PUBLIC_FIELDS, orderBy: { id: 'asc' } });
    return users.map(toPublicUser);
  }

  static async create(admin: UserPayload, body: unknown) {
    if (admin.role !== 'admin') throw Errors.forbidden('Admin access required');
    const input = validateCreateUser(body);

    // Case-insensitive duplicate check (new emails are stored lowercase; older ones may not be).
    const duplicate = await prisma.$queryRaw<Array<{ id: number }>>`SELECT id FROM users WHERE lower(email) = ${input.email} LIMIT 1`;
    if (duplicate.length > 0) throw Errors.conflict('An account with this email address already exists');

    const passwordHash = await bcryptjs.hash(input.password, config.BCRYPT_SALT_ROUNDS);
    let user: PublicUserRow;
    try {
      user = await prisma.user.create({
        data: { name: input.name, email: input.email, password: passwordHash, role: input.role === 'admin' ? 'ADMIN' : 'USER' },
        select: PUBLIC_FIELDS,
      });
    } catch (error) {
      // A concurrent request created the same email between the check and the insert.
      if ((error as { code?: string }).code === 'P2002') throw Errors.conflict('An account with this email address already exists');
      throw error;
    }
    // Ids and role only - no email, name or password in logs.
    logger.info('User account created by admin', { userId: user.id, role: input.role, createdBy: admin.id });
    return toPublicUser(user);
  }

  /**
   * Sets a new password (bcrypt, same rules as creation) and signs the
   * account out of its existing sessions, so the old password cannot keep
   * anyone logged in. An admin changing their own password keeps the
   * session they are using. Deactivated accounts are refused.
   */
  static async changePassword(admin: UserPayload, targetId: number, body: unknown, currentSessionId?: number) {
    if (admin.role !== 'admin') throw Errors.forbidden('Admin access required');
    const { password } = validateChangePassword(body);
    const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, deactivatedAt: true } });
    if (!target) throw Errors.notFound('User');
    if (target.deactivatedAt) throw Errors.conflict('This account has been deleted; its password cannot be changed.');

    const passwordHash = await bcryptjs.hash(password, config.BCRYPT_SALT_ROUNDS);
    const keepSession = targetId === admin.id && currentSessionId !== undefined ? currentSessionId : undefined;
    const signedOut = await prisma.$transaction(async tx => {
      await tx.user.update({ where: { id: targetId }, data: { password: passwordHash } });
      const revoked = await tx.refreshToken.updateMany({
        where: { userId: targetId, revokedAt: null, ...(keepSession !== undefined ? { id: { not: keepSession } } : {}) },
        data: { revokedAt: new Date() },
      });
      return revoked.count;
    });
    // Ids and counts only - never the password.
    logger.info('User password changed by admin', { userId: targetId, changedBy: admin.id, sessionsSignedOut: signedOut });
    return { id: targetId, sessionsSignedOut: signedOut };
  }

  /** Soft-deletes (deactivates) one account; see the class comment. */
  static async deactivate(admin: UserPayload, targetId: number) {
    if (admin.role !== 'admin') throw Errors.forbidden('Admin access required');
    if (targetId === admin.id) throw Errors.badRequest('You cannot delete your own account.');

    const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, role: true, deactivatedAt: true } });
    if (!target) throw Errors.notFound('User');
    if (target.deactivatedAt) throw Errors.conflict('This account has already been deleted.');

    // One conditional UPDATE: SQLite runs it atomically, so two concurrent
    // requests cannot both pass the last-admin check. Dates are stored the
    // way Prisma stores them in SQLite (milliseconds since the epoch).
    const now = Date.now();
    const deactivated = await prisma.$transaction(async tx => {
      const changed = await tx.$executeRaw`
        UPDATE users SET deactivatedAt = ${now}, updatedAt = ${now}
        WHERE id = ${targetId} AND deactivatedAt IS NULL
          AND (role <> 'ADMIN' OR (SELECT COUNT(*) FROM users WHERE role = 'ADMIN' AND deactivatedAt IS NULL) > 1)`;
      if (changed !== 1) return false;
      await tx.refreshToken.updateMany({ where: { userId: targetId, revokedAt: null }, data: { revokedAt: new Date(now) } });
      return true;
    });

    if (!deactivated) {
      const current = await prisma.user.findUnique({ where: { id: targetId }, select: { deactivatedAt: true } });
      if (current?.deactivatedAt) throw Errors.conflict('This account has already been deleted.');
      throw Errors.conflict('The last active admin account cannot be deleted.');
    }

    logger.info('User account deactivated by admin', { userId: targetId, deactivatedBy: admin.id });
    return toPublicUser(await prisma.user.findUniqueOrThrow({ where: { id: targetId }, select: PUBLIC_FIELDS }));
  }
}

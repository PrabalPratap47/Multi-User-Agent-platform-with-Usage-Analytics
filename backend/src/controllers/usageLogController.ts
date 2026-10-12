import { Request, Response } from 'express';
import prisma from '../db/client.js';
import { asyncHandler, Errors } from '../middleware/errorHandler.js';
import { ApiResponse } from '../types/index.js';
import { parseDbId, toDbId } from '../utils/ids.js';
import { USAGE_LOG_DEFAULT_LIMIT, validateUsageLogListQuery } from '../utils/validators.js';

export class UsageLogController {
  /**
   * GET /api/usage-logs
   *
   * USER: always scoped to req.user.id (the authenticated caller),
   * regardless of anything present in the query string or body. A
   * ?userId=<someone-else> query parameter has NO effect for a non-admin -
   * it is never read for them.
   *
   * ADMIN: sees every record. An admin MAY optionally pass ?userId= to
   * filter the view, but that's a convenience filter on top of already-full
   * access, not a privilege escalation path.
   *
   * Paging: optional ?limit= (1-500) and ?offset=, newest first; without
   * them, the newest 500 rows (the original behaviour). `meta.total` counts
   * every row in the caller's scope.
   */
  static getMine = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const isAdmin = req.user.role === 'admin';
    const queryUserId = toDbId(req.query.userId);
    const { limit = USAGE_LOG_DEFAULT_LIMIT, offset = 0 } = validateUsageLogListQuery(req.query);

    const where = isAdmin
      ? queryUserId !== null
        ? { userId: queryUserId }
        : {}
      : { userId: req.user.id }; // non-admin: hard-pinned to caller's own id

    const [logs, total] = await Promise.all([
      prisma.llmUsageLog.findMany({
        where,
        include: { agent: { select: { name: true } } },
        // id breaks ties so pages never overlap or skip rows with the same createdAt.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      prisma.llmUsageLog.count({ where }),
    ]);

    res.json({
      success: true,
      data: logs,
      meta: { total, limit, offset },
    } as ApiResponse);
  });

  /**
   * GET /api/usage-logs/:userId
   *
   * :userId names the resource being requested, not the caller's identity.
   * The requireSelfOrAdmin('userId') middleware on this route already
   * rejected the request with 403 if req.user is neither admin nor the
   * owner of that id - by the time this handler runs, access is approved.
   */
  static getByUserId = asyncHandler(async (req: Request, res: Response) => {
    const targetUserId = parseDbId(req.params.userId, 'userId');

    const logs = await prisma.llmUsageLog.findMany({
      where: { userId: targetUserId },
      include: { agent: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    res.json({
      success: true,
      data: logs,
    } as ApiResponse);
  });
}

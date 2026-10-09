import { Request, Response } from 'express';
import prisma from '../db/client.js';
import { asyncHandler, Errors } from '../middleware/errorHandler.js';
import { ApiResponse } from '../types/index.js';

export class UsersController {
  /**
   * GET /api/users (ADMIN only)
   * Lists every user account. Authorization is enforced by the
   * requireAdmin middleware on the route, not by anything in this
   * handler - this handler trusts that it only runs for admins.
   */
  static listAll = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const users = await prisma.user.findMany({
      select: { id: true, email: true, role: true, createdAt: true },
      orderBy: { id: 'asc' },
    });

    res.json({
      success: true,
      data: users.map(u => ({ ...u, role: u.role.toLowerCase() })),
    } as ApiResponse);
  });
}

import { Request, Response } from 'express';
import { asyncHandler, Errors } from '../middleware/errorHandler.js';
import { ApiResponse } from '../types/index.js';
import { parseDbId } from '../utils/ids.js';
import { UsersService } from '../services/usersService.js';

/**
 * /api/users - ADMIN only. Authorization is enforced by the requireAdmin
 * middleware on the router (and again in UsersService); the acting admin
 * always comes from req.user, never from the request body or URL.
 */
export class UsersController {
  /** GET /api/users - every account (active and deactivated), without secrets. */
  static listAll = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();
    res.json({ success: true, data: await UsersService.list() } as ApiResponse);
  });

  /** POST /api/users - create an account (name, email, password, role). */
  static create = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();
    res.status(201).json({ success: true, data: await UsersService.create(req.user, req.body) } as ApiResponse);
  });

  /** PUT /api/users/:id/password - set a new password; the account's other sessions are signed out. */
  static changePassword = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();
    const id = parseDbId(req.params.id, 'user id');
    res.json({ success: true, data: await UsersService.changePassword(req.user, id, req.body, req.sessionId) } as ApiResponse);
  });

  /** DELETE /api/users/:id - soft-delete (deactivate) an account. */
  static remove = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();
    const id = parseDbId(req.params.id, 'user id');
    res.json({ success: true, data: await UsersService.deactivate(req.user, id) } as ApiResponse);
  });
}

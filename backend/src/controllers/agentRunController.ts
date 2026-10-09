import { Request, Response } from 'express';
import { asyncHandler, Errors } from '../middleware/errorHandler.js';
import { AgentRunService } from '../services/agentRunService.js';
import { ApiResponse } from '../types/index.js';

export class AgentRunController {
  /**
   * GET /api/runs?userId=&agent=&status=&limit=&offset=
   *
   * USER: always scoped to req.user.id. A ?userId= value is validated but
   * never applied for a non-admin - it cannot widen or change the scope.
   *
   * ADMIN: every user's runs; ?userId= narrows the view to one user.
   */
  static list = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();
    const page = await AgentRunService.list(req.user, req.query);
    res.json({ success: true, data: page } as ApiResponse);
  });

  /** GET /api/runs/:id - the owner or an admin; anyone else gets 403. */
  static getById = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();
    const run = await AgentRunService.getById(req.user, req.params.id);
    res.json({ success: true, data: run } as ApiResponse);
  });
}

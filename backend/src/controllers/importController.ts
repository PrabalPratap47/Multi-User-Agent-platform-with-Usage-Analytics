import { Request, Response } from 'express';
import { asyncHandler, Errors } from '../middleware/errorHandler.js';
import { parseDbId } from '../utils/ids.js';
import { ApiResponse } from '../types/index.js';
import { ExternalAgentLogService } from '../services/externalAgentLogService.js';

export class ImportController {
  /** POST /api/import/logs */
  static uploadLogs = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const log = await ExternalAgentLogService.importLog(req.user, req.body);
    res.status(201).json({ success: true, data: log } as ApiResponse);
  });

  /** GET /api/import/logs - own for a user, all for an admin */
  static listLogs = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const logs = await ExternalAgentLogService.listImports(req.user);
    res.json({ success: true, data: logs } as ApiResponse);
  });

  /** GET /api/import/logs/:importId */
  static getLogDetail = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const id = parseDbId(req.params.importId, 'importId');
    const log = await ExternalAgentLogService.getImportDetail(req.user, id);
    res.json({ success: true, data: log } as ApiResponse);
  });

  /** GET /api/import/stats - aggregate dashboard stats for the External Agent Logs tab */
  static getStats = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const stats = await ExternalAgentLogService.getStats(req.user);
    res.json({ success: true, data: stats } as ApiResponse);
  });
}

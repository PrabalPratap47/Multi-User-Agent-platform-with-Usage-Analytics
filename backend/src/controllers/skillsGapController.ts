import { Request, Response } from 'express';
import { asyncHandler, Errors } from '../middleware/errorHandler.js';
import { parseDbId } from '../utils/ids.js';
import { ApiResponse } from '../types/index.js';
import { SkillsGapService, PdfExtractionError, SkillsGapValidationError } from '../services/skillsGapService.js';
import { LLMServiceError, providerFailureMessage } from '../services/llmService.js';

/** Safe errors only: never raw model output, prompts or provider internals. */
function toSafeSkillsGapError(error: unknown): unknown {
  if (error instanceof PdfExtractionError) return Errors.badRequest(error.message);
  if (error instanceof SkillsGapValidationError) {
    return Errors.badGateway('The skills gap analysis could not be completed: the AI response did not pass validation. Please try again.');
  }
  if (error instanceof LLMServiceError) return Errors.badGateway(providerFailureMessage(error));
  return error;
}

export class SkillsGapController {
  /** GET /api/skills-gap/roles - target roles and their expected skills */
  static getRoles = asyncHandler(async (_req: Request, res: Response) => {
    res.json({ success: true, data: SkillsGapService.listRoles() } as ApiResponse);
  });

  /** POST /api/skills-gap/analyze - analyze a CV (text or PDF) for a target role; owned by req.user */
  static analyze = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();
    try {
      const analysis = await SkillsGapService.analyze(req.user, req.body);
      res.status(201).json({ success: true, data: analysis } as ApiResponse);
    } catch (error) {
      throw toSafeSkillsGapError(error);
    }
  });

  /** GET /api/skills-gap/analyses - own for a user, all for an admin */
  static list = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();
    res.json({ success: true, data: await SkillsGapService.list(req.user) } as ApiResponse);
  });

  /** DELETE /api/skills-gap/analyses/:id - admin only (also enforced by the route) */
  static remove = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();
    const id = parseDbId(req.params.id, 'analysis id');
    res.json({ success: true, data: await SkillsGapService.delete(req.user, id) } as ApiResponse);
  });

  /** GET /api/skills-gap/analyses/:id - ownership-enforced */
  static get = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();
    const id = parseDbId(req.params.id, 'analysis id');
    res.json({ success: true, data: await SkillsGapService.get(req.user, id) } as ApiResponse);
  });
}

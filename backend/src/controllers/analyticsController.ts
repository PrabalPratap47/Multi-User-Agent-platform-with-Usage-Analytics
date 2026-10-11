import { Request, Response } from 'express';
import { asyncHandler, Errors } from '../middleware/errorHandler.js';
import { ApiResponse } from '../types/index.js';
import { AnalyticsService } from '../services/analyticsService.js';
import { toDbId } from '../utils/ids.js';

/**
 * Admin may pass ?userId= to drill into one user's data; for a
 * non-admin this is parsed but simply never used (userScope in
 * analyticsService.ts ignores it entirely for non-admins) - the
 * authenticated user's own id from req.user is what actually scopes
 * every query, never a query parameter alone.
 */
function parseOptionalUserId(raw: unknown): number | undefined {
  return toDbId(raw) ?? undefined;
}

export class AnalyticsController {
  /** GET /api/analytics/summary - metrics 1-4: overall tokens + cost */
  static getSummary = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const summary = await AnalyticsService.getTokenSummary(req.user, parseOptionalUserId(req.query.userId));
    res.json({ success: true, data: summary } as ApiResponse);
  });

  /** GET /api/analytics/tokens - alias of summary (kept for the originally scaffolded route name) */
  static getTokens = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const summary = await AnalyticsService.getTokenSummary(req.user, parseOptionalUserId(req.query.userId));
    res.json({ success: true, data: summary } as ApiResponse);
  });

  /** GET /api/analytics/by-user - metric 5 (admin only, enforced by route) */
  static getByUser = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const breakdown = await AnalyticsService.getTokensByUser();
    res.json({ success: true, data: breakdown } as ApiResponse);
  });

  /** GET /api/analytics/by-agent - metric 6 */
  static getByAgent = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const breakdown = await AnalyticsService.getTokensByAgent(req.user, parseOptionalUserId(req.query.userId));
    res.json({ success: true, data: breakdown } as ApiResponse);
  });

  /** GET /api/analytics/runs - metric 7: agent run counts (24h/7d/30d) */
  static getRunCounts = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const counts = await AnalyticsService.getAgentRunCounts(req.user, parseOptionalUserId(req.query.userId));
    res.json({ success: true, data: counts } as ApiResponse);
  });

  /** GET /api/analytics/errors - metric 8: error rate by agent */
  static getErrors = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const rates = await AnalyticsService.getErrorRateByAgent(req.user, parseOptionalUserId(req.query.userId));
    res.json({ success: true, data: rates } as ApiResponse);
  });

  /** GET /api/analytics/latency - metric 9: average latency by agent */
  static getLatency = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const latencies = await AnalyticsService.getAverageLatencyByAgent(req.user, parseOptionalUserId(req.query.userId));
    res.json({ success: true, data: latencies } as ApiResponse);
  });

  /** GET /api/analytics/acceptance-rate - metric 10: CV acceptance rate per category */
  static getAcceptanceRate = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const rates = await AnalyticsService.getAcceptanceRateByCategory(req.user, parseOptionalUserId(req.query.userId));
    res.json({ success: true, data: rates } as ApiResponse);
  });

  /** GET /api/analytics/final-categories - metric 10b: original AI recommendation vs final category */
  static getFinalCategories = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const breakdown = await AnalyticsService.getFinalCategoryBreakdown(req.user, parseOptionalUserId(req.query.userId));
    res.json({ success: true, data: breakdown } as ApiResponse);
  });

  /** GET /api/analytics/time-saved - metric 11: ESTIMATED time saved in person-hours */
  static getTimeSaved = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const estimate = await AnalyticsService.getTimeSaved(req.user, parseOptionalUserId(req.query.userId));
    res.json({ success: true, data: estimate } as ApiResponse);
  });

  /** GET /api/analytics/usage-completeness - where the token/cost totals are missing or incomplete usage */
  static getUsageCompleteness = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const completeness = await AnalyticsService.getUsageCompleteness(req.user, parseOptionalUserId(req.query.userId));
    res.json({ success: true, data: completeness } as ApiResponse);
  });

  /** GET /api/analytics/evaluation - CV classification precision/recall (not yet implemented) */
  static getEvaluation = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();
    // TODO: requires a labeled evaluation dataset - not part of this change.
    res.json({
      success: true,
      message: 'Evaluation metrics endpoint - to be implemented (needs a labeled dataset)',
    } as ApiResponse);
  });
}

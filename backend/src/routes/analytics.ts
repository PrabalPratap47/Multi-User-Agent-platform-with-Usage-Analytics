import { Router } from 'express';
import { AnalyticsController } from '../controllers/analyticsController.js';
import { authenticateToken, requireUser, requireAdmin } from '../middleware/authMiddleware.js';

const router = Router();

router.use(authenticateToken, requireUser);

router.get('/summary', AnalyticsController.getSummary);
router.get('/tokens', AnalyticsController.getTokens);
router.get('/by-agent', AnalyticsController.getByAgent);
router.get('/runs', AnalyticsController.getRunCounts);
router.get('/errors', AnalyticsController.getErrors);
router.get('/latency', AnalyticsController.getLatency);
router.get('/acceptance-rate', AnalyticsController.getAcceptanceRate);
router.get('/final-categories', AnalyticsController.getFinalCategories);
router.get('/time-saved', AnalyticsController.getTimeSaved);
router.get('/usage-completeness', AnalyticsController.getUsageCompleteness);
router.get('/evaluation', AnalyticsController.getEvaluation);

// Admin only
router.get('/by-user', requireAdmin, AnalyticsController.getByUser);

export default router;

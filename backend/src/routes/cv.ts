import { Router } from 'express';
import { CVController } from '../controllers/cvController.js';
import { authenticateToken, requireAdmin, requireUser } from '../middleware/authMiddleware.js';
import { aiRateLimit, runsPerBatchFile } from '../middleware/aiRateLimit.js';

const router = Router();

router.use(authenticateToken, requireUser);

// Uploading/submitting a CV
router.post('/documents', CVController.uploadDocument);
// Permanently deleting one CV (admin only; runs and usage logs are kept)
router.delete('/documents/:documentId', requireAdmin, CVController.deleteDocument);

// Running classification (starts AI work: per-user rate limit)
router.post('/documents/:documentId/classify', aiRateLimit(), CVController.classifyDocument);
router.post('/classify', aiRateLimit(), CVController.classify); // convenience: upload + classify in one call

// Retrieving the result
router.get('/results', CVController.getResults);
router.get('/results/:id', CVController.getResult);

// Decision workflow: ACCEPT / MODIFY / REJECT
router.post('/results/:id/decision', CVController.makeDecision);
router.get('/results/:id/decisions', CVController.getDecisions);

// Batch processing (one AI run per file counts toward the rate limit)
router.post('/batch', aiRateLimit(runsPerBatchFile), CVController.batch);
router.get('/batch/:batchId/status', CVController.batchStatus);

export default router;

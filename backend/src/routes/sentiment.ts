import { Router } from 'express';
import { SentimentController } from '../controllers/sentimentController.js';
import { authenticateToken, requireAdmin, requireUser } from '../middleware/authMiddleware.js';
import { aiRateLimit } from '../middleware/aiRateLimit.js';

const router = Router();

router.use(authenticateToken, requireUser);

router.post('/analyze', aiRateLimit(), SentimentController.analyze); // starts AI work: per-user rate limit
router.get('/results', SentimentController.getResults);
router.get('/results/:id', SentimentController.getResult);
router.delete('/results/:id', requireAdmin, SentimentController.deleteResult); // admin only; run and usage logs are kept

export default router;

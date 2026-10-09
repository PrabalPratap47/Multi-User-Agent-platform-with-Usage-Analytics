import { Router } from 'express';
import { SentimentController } from '../controllers/sentimentController.js';
import { authenticateToken, requireUser } from '../middleware/authMiddleware.js';
import { aiRateLimit } from '../middleware/aiRateLimit.js';

const router = Router();

router.use(authenticateToken, requireUser);

router.post('/analyze', aiRateLimit(), SentimentController.analyze); // starts AI work: per-user rate limit
router.get('/results', SentimentController.getResults);
router.get('/results/:id', SentimentController.getResult);

export default router;

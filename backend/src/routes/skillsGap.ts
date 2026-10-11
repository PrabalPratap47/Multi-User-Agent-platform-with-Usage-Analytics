import { Router } from 'express';
import { SkillsGapController } from '../controllers/skillsGapController.js';
import { authenticateToken, requireAdmin, requireUser } from '../middleware/authMiddleware.js';
import { aiRateLimit } from '../middleware/aiRateLimit.js';

const router = Router();

router.use(authenticateToken, requireUser);

router.get('/roles', SkillsGapController.getRoles);
router.post('/analyze', aiRateLimit(), SkillsGapController.analyze); // starts AI work: per-user rate limit
router.get('/analyses', SkillsGapController.list);
router.get('/analyses/:id', SkillsGapController.get);
router.delete('/analyses/:id', requireAdmin, SkillsGapController.remove); // admin only; run and usage logs are kept

export default router;

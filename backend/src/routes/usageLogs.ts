import { Router } from 'express';
import { UsageLogController } from '../controllers/usageLogController.js';
import { authenticateToken, requireUser, requireSelfOrAdmin } from '../middleware/authMiddleware.js';

const router = Router();

router.use(authenticateToken, requireUser);

router.get('/', UsageLogController.getMine);
router.get('/:userId', requireSelfOrAdmin('userId'), UsageLogController.getByUserId);

export default router;

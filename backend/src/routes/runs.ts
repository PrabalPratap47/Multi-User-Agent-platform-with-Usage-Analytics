import { Router } from 'express';
import { AgentRunController } from '../controllers/agentRunController.js';
import { authenticateToken, requireUser } from '../middleware/authMiddleware.js';

const router = Router();

router.use(authenticateToken, requireUser);

router.get('/', AgentRunController.list);
router.get('/:id', AgentRunController.getById);

export default router;

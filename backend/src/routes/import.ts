import { Router } from 'express';
import { ImportController } from '../controllers/importController.js';
import { authenticateToken, requireUser } from '../middleware/authMiddleware.js';

const router = Router();

router.use(authenticateToken, requireUser);

router.post('/logs', ImportController.uploadLogs);
router.get('/logs', ImportController.listLogs);
router.get('/stats', ImportController.getStats);
router.get('/logs/:importId', ImportController.getLogDetail);

export default router;

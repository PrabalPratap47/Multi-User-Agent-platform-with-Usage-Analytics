import { Router } from 'express';
import { UsersController } from '../controllers/usersController.js';
import { authenticateToken, requireAdmin } from '../middleware/authMiddleware.js';

const router = Router();

router.use(authenticateToken, requireAdmin);

router.get('/', UsersController.listAll);

export default router;

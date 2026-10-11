import { Router } from 'express';
import { UsersController } from '../controllers/usersController.js';
import { authenticateToken, requireAdmin } from '../middleware/authMiddleware.js';

const router = Router();

router.use(authenticateToken, requireAdmin);

router.get('/', UsersController.listAll);
router.post('/', UsersController.create);
router.put('/:id/password', UsersController.changePassword);
router.delete('/:id', UsersController.remove); // soft delete (deactivation)

export default router;

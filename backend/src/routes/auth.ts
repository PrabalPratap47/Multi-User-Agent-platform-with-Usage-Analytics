import { Router } from 'express';
import { AuthController } from '../controllers/authController.js';
import { authenticateToken } from '../middleware/authMiddleware.js';

const router = Router();

// Public
router.post('/login', AuthController.login);
router.post('/refresh', AuthController.refresh);

// Protected - identity comes from the verified access token
router.post('/logout', authenticateToken, AuthController.logout);
router.get('/me', authenticateToken, AuthController.me);

export default router;

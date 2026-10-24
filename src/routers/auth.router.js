import { Router } from 'express';
import {
  register,
  login,
  logout,
  refreshToken,
  verifyAuth,
  changePassword,
} from '../controllers/auth.controller.js';
import { protect } from '../middlewares/auth.middleware.js';
import { authLimiter } from '../middlewares/rateLimit.middleware.js';

const router = Router();

router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);
router.post('/logout', protect, logout);
router.post('/refresh', protect, refreshToken);
router.get('/me', protect, verifyAuth);
router.get('/verify', protect, verifyAuth);
router.post('/change-password', protect, changePassword);

export default router;

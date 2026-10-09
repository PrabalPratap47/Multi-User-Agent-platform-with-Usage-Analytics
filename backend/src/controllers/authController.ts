import { Request, Response } from 'express';
import { AuthService } from '../services/authService.js';
import { asyncHandler, Errors } from '../middleware/errorHandler.js';
import { validateLogin } from '../utils/validators.js';
import { ApiResponse, LoginResponse, UserPayload } from '../types/index.js';

export class AuthController {
  /**
   * POST /api/auth/login (public)
   */
  static login = asyncHandler(async (req: Request, res: Response) => {
    const loginRequest = validateLogin(req.body);
    const result = await AuthService.login(loginRequest, req.ip ?? 'unknown');

    res.json({
      success: true,
      data: result,
    } as ApiResponse<LoginResponse>);
  });

  /**
   * POST /api/auth/refresh (public - the refresh token itself is the credential)
   */
  static refresh = asyncHandler(async (req: Request, res: Response) => {
    const { refreshToken } = req.body;

    if (!refreshToken || typeof refreshToken !== 'string') {
      throw Errors.badRequest('Refresh token is required');
    }

    const result = await AuthService.refreshToken(refreshToken);

    res.json({
      success: true,
      data: result,
    } as ApiResponse<{ accessToken: string; refreshToken: string }>);
  });

  /**
   * POST /api/auth/logout (requires a valid access token)
   * Ends the session the access token belongs to (so that token stops
   * working immediately), plus the refresh token in the body if it belongs
   * to req.user.id - the caller can never revoke someone else's session.
   */
  static logout = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const { refreshToken } = req.body as { refreshToken?: string };
    await AuthService.logout(req.user.id, req.sessionId, typeof refreshToken === 'string' ? refreshToken : undefined);

    res.json({
      success: true,
      message: 'Logged out successfully',
    } as ApiResponse);
  });

  /**
   * GET /api/auth/me (requires a valid access token)
   * Returns the identity of the CALLER, derived exclusively from the
   * verified JWT (req.user.id) - never from a query/body/param.
   */
  static me = asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw Errors.unauthorized();

    const user = await AuthService.getCurrentUser(req.user.id);

    res.json({
      success: true,
      data: user,
    } as ApiResponse<UserPayload>);
  });
}

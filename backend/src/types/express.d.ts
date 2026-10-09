import type { UserPayload } from './index.js';

// Set only by authenticateToken (middleware/authMiddleware.ts) from the verified JWT.
declare global {
  namespace Express {
    interface Request {
      user?: UserPayload;
      /** The login session (RefreshToken row id) the access token belongs to. */
      sessionId?: number;
    }
  }
}

export {};

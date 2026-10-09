import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import logger from '../config/logging.js';
import { ErrorResponse } from '../types/index.js';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public code?: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function errorHandler(
  error: Error | AppError | ZodError,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  // body-parser errors. The JSON parse message quotes part of the raw body
  // (which may hold a password), so it is neither logged nor returned.
  const bodyError = error as { type?: string };
  if (bodyError.type === 'entity.parse.failed') {
    logger.warn('Rejected request with malformed JSON body', { url: req.path, method: req.method });
    return res.status(400).json({ success: false, error: 'Malformed JSON request body', code: 'INVALID_JSON' } as ErrorResponse);
  }
  if (bodyError.type === 'entity.too.large') {
    logger.warn('Rejected oversized request body', { url: req.path, method: req.method });
    return res.status(413).json({ success: false, error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' } as ErrorResponse);
  }

  logger.error('Request error', {
    url: req.path,
    method: req.method,
    error: error.message,
    stack: error instanceof Error ? error.stack : undefined,
  });

  if (error instanceof ZodError) {
    const fieldErrors = error.errors.map(e => ({
      field: e.path.join('.'),
      message: e.message,
    }));

    return res.status(400).json({
      success: false,
      error: 'Validation error',
      code: 'VALIDATION_ERROR',
      details: { fields: fieldErrors },
    } as ErrorResponse);
  }

  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      success: false,
      error: error.message,
      code: error.code,
      details: error.details,
    } as ErrorResponse);
  }

  // Unexpected error
  return res.status(500).json({
    success: false,
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  } as ErrorResponse);
}

// Common error constructors
export const Errors = {
  unauthorized: () => new AppError(401, 'Unauthorized', 'UNAUTHORIZED'),
  forbidden: (resource?: string) =>
    new AppError(403, `Forbidden${resource ? ` - ${resource}` : ''}`, 'FORBIDDEN'),
  notFound: (resource: string) =>
    new AppError(404, `${resource} not found`, 'NOT_FOUND'),
  badRequest: (message: string) =>
    new AppError(400, message, 'BAD_REQUEST'),
  conflict: (message: string) =>
    new AppError(409, message, 'CONFLICT'),
  tooManyRequests: (message: string) =>
    new AppError(429, message, 'TOO_MANY_REQUESTS'),
  validation: (message: string, details?: Record<string, unknown>) =>
    new AppError(400, message, 'VALIDATION_ERROR', details),
  internal: (message: string) =>
    new AppError(500, message, 'INTERNAL_ERROR'),
  // For failures that are the UPSTREAM provider's fault, not the
  // client's request - e.g. the LLM never returned a schema-conforming
  // response even after a repair retry. 400 would wrongly imply the
  // client should change their request; the same request may well
  // succeed on a later attempt.
  badGateway: (message: string) =>
    new AppError(502, message, 'BAD_GATEWAY'),
};

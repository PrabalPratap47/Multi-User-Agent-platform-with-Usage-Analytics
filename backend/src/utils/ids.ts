import { Errors } from '../middleware/errorHandler.js';

/** Largest value of a Prisma Int column (32-bit signed). */
export const MAX_DB_ID = 2_147_483_647;

/** A positive database id, or null for anything else ("1.5", "-1", "1e3", out of range, ...). */
export function toDbId(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^[1-9]\d{0,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id <= MAX_DB_ID ? id : null;
}

/** Route-param id: anything that is not a valid database id is a 400, never a 404/500. */
export function parseDbId(raw: unknown, label: string): number {
  const id = toDbId(raw);
  if (id === null) {
    throw Errors.badRequest(`Invalid ${label}`);
  }
  return id;
}

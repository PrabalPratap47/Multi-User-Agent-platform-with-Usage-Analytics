import prisma from '../db/client.js';
import logger from '../config/logging.js';

/**
 * Startup recovery for agent runs left unfinished by a previous backend
 * process (stopped, crashed or restarted mid-work).
 *
 * Agent work runs inside the backend process, so a run still PENDING or
 * RUNNING when the process starts can never finish: nothing is working on it
 * any more. Such runs are failed, not resumed:
 * - a queued batch file's MIME type is not persisted, so its file-type check
 *   cannot be re-run, and sentiment input is only stored on success;
 * - a RUNNING run may already have made a (billed) provider call, so
 *   resuming could pay for the same work twice;
 * - resuming at startup would make AI calls nobody asked for at that time.
 *
 * Nothing else changes: no usage rows are written or removed (AI calls that
 * finished before the restart keep the rows they already have), owners,
 * batch ids and documents stay as they are, and SUCCESS/ERROR runs are never
 * touched. Assumes one backend process per database (see docs/DATABASE.md).
 */

/** PENDING = a queued batch file: it never started, so it never reached the AI provider. */
export const INTERRUPTED_QUEUED_REASON =
  'Not processed: the backend restarted before this file was started, so no AI call was made. Please upload it again.';

/** RUNNING = work was in progress; it may or may not have reached the AI provider. */
export const INTERRUPTED_RUNNING_REASON =
  'Interrupted: the backend restarted while this run was in progress. It was stopped and not retried; please submit it again.';

export interface RunRecoveryResult {
  /** PENDING runs (queued batch files) marked ERROR. */
  queued: number;
  /** RUNNING runs (batch files, single CVs, sentiment) marked ERROR. */
  running: number;
}

const LOGGED_RUN_IDS = 20;

/**
 * Marks every PENDING/RUNNING run created before `createdBefore` as ERROR
 * with the matching reason, and returns how many of each were changed.
 *
 * `createdBefore` is the moment the current process started, so runs this
 * process creates are never affected. Each update only matches rows still in
 * that non-terminal status, so a second call (or a run that already ended)
 * changes nothing.
 */
export async function recoverInterruptedRuns(createdBefore: Date): Promise<RunRecoveryResult> {
  const stale = { createdAt: { lt: createdBefore } };
  const affected = await prisma.agentRun.findMany({
    where: { ...stale, status: { in: ['PENDING', 'RUNNING'] } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: LOGGED_RUN_IDS,
  });

  const recoveredAt = new Date();
  const [queued, running] = await prisma.$transaction([
    prisma.agentRun.updateMany({
      where: { ...stale, status: 'PENDING' },
      data: { status: 'ERROR', completedAt: recoveredAt, errorMessage: INTERRUPTED_QUEUED_REASON },
    }),
    prisma.agentRun.updateMany({
      where: { ...stale, status: 'RUNNING' },
      data: { status: 'ERROR', completedAt: recoveredAt, errorMessage: INTERRUPTED_RUNNING_REASON },
    }),
  ]);

  const result = { queued: queued.count, running: running.count };
  if (result.queued + result.running > 0) {
    logger.warn('Marked agent runs interrupted by a previous backend process as ERROR (not retried)', {
      event: 'INTERRUPTED_RUNS_RECOVERED',
      ...result,
      runIds: affected.map(r => r.id),
      runIdsTruncated: result.queued + result.running > affected.length,
    });
  } else {
    logger.info('No agent runs were left unfinished by a previous backend process');
  }
  return result;
}

import bcryptjs from 'bcryptjs';
import request from 'supertest';
import prisma from '../src/db/client.js';
import config from '../src/config/env.js';
import app from '../src/app.js';

export const TEST_PASSWORD = 'Test-Password-123!';

const EMAILS = {
  admin: 'rbac-test-admin@test.local',
  user1: 'rbac-test-user1@test.local',
  user2: 'rbac-test-user2@test.local',
} as const;

export interface Fixtures {
  adminId: number;
  user1Id: number;
  user2Id: number;
  agentId: number;
  user1LogId: number;
  user2LogId: number;
}

/**
 * Wipes out anything left over from a previous run of this suite (by the
 * namespaced test emails/agent name, never a blanket delete) and creates a
 * known-good fixture set: one admin, two regular users, and one usage-log
 * record owned by each regular user.
 */
export async function setupFixtures(): Promise<Fixtures> {
  await cleanupFixtures();

  const passwordHash = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);

  const admin = await prisma.user.create({
    data: { email: EMAILS.admin, password: passwordHash, role: 'ADMIN' },
  });
  const user1 = await prisma.user.create({
    data: { email: EMAILS.user1, password: passwordHash, role: 'USER' },
  });
  const user2 = await prisma.user.create({
    data: { email: EMAILS.user2, password: passwordHash, role: 'USER' },
  });

  const agent = await prisma.agent.create({
    data: { name: 'RBAC Test Agent', description: 'Used only by the auth/RBAC test suite' },
  });

  const user1Log = await prisma.llmUsageLog.create({
    data: {
      timestamp: new Date(),
      userId: user1.id,
      agentId: agent.id,
      agentName: agent.name,
      model: 'gpt-4o',
      inputTokens: 111,
      outputTokens: 22,
      latencyMs: 500,
      status: 'SUCCESS',
      estimatedCost: 0.01,
      isSeedData: true,
    },
  });

  const user2Log = await prisma.llmUsageLog.create({
    data: {
      timestamp: new Date(),
      userId: user2.id,
      agentId: agent.id,
      agentName: agent.name,
      model: 'gpt-4o',
      inputTokens: 222,
      outputTokens: 33,
      latencyMs: 700,
      status: 'SUCCESS',
      estimatedCost: 0.02,
      isSeedData: true,
    },
  });

  return {
    adminId: admin.id,
    user1Id: user1.id,
    user2Id: user2.id,
    agentId: agent.id,
    user1LogId: user1Log.id,
    user2LogId: user2Log.id,
  };
}

export async function cleanupFixtures(): Promise<void> {
  const emails = Object.values(EMAILS);

  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  });
  const userIds = users.map(u => u.id);

  if (userIds.length > 0) {
    await prisma.llmUsageLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  }

  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.agent.deleteMany({ where: { name: 'RBAC Test Agent' } });
}

export const testEmails = EMAILS;

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: { id: number; email: string; role: 'admin' | 'user' };
}

export async function loginAs(email: string, password = TEST_PASSWORD): Promise<LoginResult> {
  const res = await request(app).post('/api/auth/login').send({ email, password });

  if (res.status !== 200) {
    throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }

  return res.body.data as LoginResult;
}

export { app };

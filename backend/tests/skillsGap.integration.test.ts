import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import bcryptjs from 'bcryptjs';
import request from 'supertest';
import { app, loginAs, TEST_PASSWORD } from './helpers.js';
import prisma from '../src/db/client.js';
import config from '../src/config/env.js';
import { SkillsGapAgent, skillsGapAgent as realAgent, __setSkillsGapAgentForTesting, SKILLS_GAP_AGENT_NAME } from '../src/agents/SkillsGapAgent.js';
import { LLMService, type LLMProviderResponse } from '../src/services/llmService.js';
import { SAMPLE_CV, validAnalysis, PSS_CV, DCS_CV, analysisFor } from './fixtures/skillsGapFixtures.js';
import * as roleConfig from '../src/agents/skillsGap/roles.js';
import type { LLMProviderRequest } from '../src/services/llmService.js';
import { textPdf, toBase64 } from './fixtures/pdfFixtures.js';

/** POST/GET /api/skills-gap/* through the real routes, auth, service and database; the model is scripted. */

const EMAIL = { a: 'skills-gap-a@test.local', b: 'skills-gap-b@test.local', admin: 'skills-gap-admin@test.local' } as const;
const token = { a: '', b: '', admin: '' };
const uid = { a: 0, b: 0 };
let providerCalls = 0;

const REAL_USAGE = { prompt_tokens: 1234, completion_tokens: 567 };

function useModel(reply: () => string, usage: LLMProviderResponse['usage'] | 'none' = REAL_USAGE) {
  __setSkillsGapAgentForTesting(
    new SkillsGapAgent(
      new LLMService({
        messages: {
          create: async () => {
            providerCalls += 1;
            return { id: `chatcmpl-skills-${providerCalls}`, content: [{ type: 'text', text: reply() }], model: 'gpt-4o-2024-08-06', usage: usage === 'none' ? undefined : usage };
          },
        },
      })
    )
  );
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { in: Object.values(EMAIL) } }, select: { id: true } });
  const userId = { in: users.map(u => u.id) };
  await prisma.skillsGapAnalysis.deleteMany({ where: { userId } });
  await prisma.llmUsageLog.deleteMany({ where: { userId } });
  await prisma.agentRun.deleteMany({ where: { userId } });
  await prisma.refreshToken.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAIL) } } });
}

const post = (who: keyof typeof token | null, body: object) => {
  const req = request(app).post('/api/skills-gap/analyze');
  return (who ? req.set('Authorization', `Bearer ${token[who]}`) : req).send(body);
};
const get = (who: keyof typeof token, path: string) => request(app).get(path).set('Authorization', `Bearer ${token[who]}`);

beforeAll(async () => {
  await cleanup();
  const password = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  uid.a = (await prisma.user.create({ data: { email: EMAIL.a, password, role: 'USER' } })).id;
  uid.b = (await prisma.user.create({ data: { email: EMAIL.b, password, role: 'USER' } })).id;
  await prisma.user.create({ data: { email: EMAIL.admin, password, role: 'ADMIN' } });
  token.a = (await loginAs(EMAIL.a)).accessToken;
  token.b = (await loginAs(EMAIL.b)).accessToken;
  token.admin = (await loginAs(EMAIL.admin)).accessToken;
});

beforeEach(() => {
  useModel(() => JSON.stringify(validAnalysis()));
});

afterAll(async () => {
  __setSkillsGapAgentForTesting(realAgent);
  await cleanup();
});

describe('Skills gap API', () => {
  it('requires authentication on every endpoint', async () => {
    for (const res of [await post(null, { targetRole: 'Front-End Developer', cvContent: SAMPLE_CV }), await request(app).get('/api/skills-gap/roles'), await request(app).get('/api/skills-gap/analyses'), await request(app).get('/api/skills-gap/analyses/1')]) {
      expect(res.status).toBe(401);
    }
  });

  it('lists the configured roles with their expected skills and gap priorities', async () => {
    const roles = (await get('a', '/api/skills-gap/roles')).body.data as Array<{ role: string; label: string; skills: Array<{ name: string; gapPriority: string }> }>;
    expect(roles.map(r => r.role)).toEqual(['Front-End Developer', 'Back-End Developer', 'Web Automation Engineer', 'Mobile Automation Engineer', 'AI Engineer', 'Chatbot Application Tester', 'PSS', 'DCS']);
    expect(roles.find(r => r.role === 'PSS')).toMatchObject({ label: 'Passenger Service System' });
    expect(roles.find(r => r.role === 'DCS')).toMatchObject({ label: 'Departure Control System' });
    expect(roles[0].skills.find(s => s.name === 'Front-end testing')?.gapPriority).toBe('Medium');
  });

  it('analyzes a CV for the selected role, saves it for the authenticated user (a body userId is ignored) and logs real token usage', async () => {
    const res = await post('a', { targetRole: 'Front-End Developer', cvContent: SAMPLE_CV, fileName: 'sam.txt', userId: uid.b });
    expect(res.status).toBe(201);
    const saved = await prisma.skillsGapAnalysis.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(saved).toMatchObject({ userId: uid.a, targetRole: 'Front-End Developer', cvFileName: 'sam.txt', cvCharCount: SAMPLE_CV.length });
    expect(saved.result).toEqual(validAnalysis());
    expect(JSON.stringify(saved)).not.toContain('Sam Rivera - front-end developer (synthetic test CV).\nBuilt'); // the CV text is not stored

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: saved.runId! } });
    expect(run).toMatchObject({ userId: uid.a, agentName: SKILLS_GAP_AGENT_NAME, status: 'SUCCESS' });
    const logs = await prisma.llmUsageLog.findMany({ where: { runId: run.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ userId: uid.a, agentName: SKILLS_GAP_AGENT_NAME, model: 'gpt-4o-2024-08-06', inputTokens: 1234, outputTokens: 567, status: 'SUCCESS', errorCode: null });
    expect(logs[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(logs[0].estimatedCost).toBeGreaterThan(0);
  });

  it('records missing provider usage honestly (0 tokens and an error code, never an estimate)', async () => {
    useModel(() => JSON.stringify(validAnalysis()), 'none');
    const res = await post('a', { targetRole: 'Front-End Developer', cvContent: SAMPLE_CV });
    expect(res.status).toBe(201);
    const run = await prisma.skillsGapAnalysis.findUniqueOrThrow({ where: { id: res.body.data.id } });
    const [log] = await prisma.llmUsageLog.findMany({ where: { runId: run.runId! } });
    expect(log).toMatchObject({ inputTokens: 0, outputTokens: 0, errorCode: 'MISSING_USAGE_DATA' });
  });

  it('accepts a text-based PDF through the existing PDF extraction', async () => {
    const pdf = textPdf([SAMPLE_CV.split('\n')]);
    const res = await post('a', { targetRole: 'Front-End Developer', pdfBase64: toBase64(pdf), fileName: 'sam.pdf' });
    expect(res.status).toBe(201);
    expect(res.body.data.cvFileName).toBe('sam.pdf');
  }, 60_000);

  it('rejects bad requests with 400 before any AI call', async () => {
    const before = providerCalls;
    for (const body of [
      { targetRole: 'Astronaut', cvContent: SAMPLE_CV },
      { targetRole: 'Front-End Developer' },
      { targetRole: 'Front-End Developer', cvContent: SAMPLE_CV, pdfBase64: 'JVBERi0=' },
      { targetRole: 'Front-End Developer', cvContent: 'too short' },
      { targetRole: 'Front-End Developer', pdfBase64: toBase64(Buffer.from('not a pdf at all, just text')) },
    ]) {
      expect((await post('a', body)).status).toBe(400);
    }
    expect(providerCalls).toBe(before);
  });

  it('returns a safe 502 for invalid model output, stores nothing and records the failure on the run', async () => {
    useModel(() => '{"targetRole": "Front-End Developer", "note": "not the schema"}');
    const before = await prisma.skillsGapAnalysis.count({ where: { userId: uid.a } });
    const res = await post('a', { targetRole: 'Front-End Developer', cvContent: SAMPLE_CV });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toMatch(/not the schema|SECURITY - MANDATORY|stack/i);
    expect(await prisma.skillsGapAnalysis.count({ where: { userId: uid.a } })).toBe(before);
    const run = await prisma.agentRun.findFirstOrThrow({ where: { userId: uid.a, agentName: SKILLS_GAP_AGENT_NAME }, orderBy: { createdAt: 'desc' } });
    expect(run).toMatchObject({ status: 'ERROR', errorMessage: 'The AI response did not pass validation, even after one automatic retry.' });
    expect(await prisma.llmUsageLog.count({ where: { runId: run.id } })).toBe(2); // first attempt + one repair, both logged
  });

  it('keeps analyses private: a user sees and opens only their own; an admin sees everyone’s', async () => {
    const own = (await post('a', { targetRole: 'Front-End Developer', cvContent: SAMPLE_CV })).body.data.id as number;
    const theirs = (await post('b', { targetRole: 'Front-End Developer', cvContent: SAMPLE_CV })).body.data.id as number;

    expect((await get('a', `/api/skills-gap/analyses/${own}`)).status).toBe(200);
    const denied = await get('a', `/api/skills-gap/analyses/${theirs}`);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain('overallSummary');
    expect((await get('a', `/api/skills-gap/analyses/${theirs}?userId=${uid.b}`)).status).toBe(403);
    expect((await get('a', '/api/skills-gap/analyses/999999999')).status).toBe(404);

    const listA = (await get('a', '/api/skills-gap/analyses')).body.data as Array<{ id: number; userId: number }>;
    expect(listA.every(a => a.userId === uid.a)).toBe(true);
    expect(listA.map(a => a.id)).toContain(own);
    expect(listA.map(a => a.id)).not.toContain(theirs);

    expect((await get('admin', `/api/skills-gap/analyses/${theirs}`)).status).toBe(200);
    const all = (await get('admin', '/api/skills-gap/analyses')).body.data as Array<{ id: number }>;
    expect(all.map(a => a.id)).toEqual(expect.arrayContaining([own, theirs]));
  });
});

describe('DELETE /api/skills-gap/analyses/:id (admin only)', () => {
  const del = (who: keyof typeof token | null, id: number | string) => {
    const req = request(app).delete(`/api/skills-gap/analyses/${id}`);
    return who ? req.set('Authorization', `Bearer ${token[who]}`) : req;
  };

  it('lets an admin delete one analysis: gone from lists and reads, its run and usage log kept, other analyses untouched', async () => {
    const target = (await post('a', { targetRole: 'Front-End Developer', cvContent: SAMPLE_CV, fileName: 'delete-me.txt' })).body.data;
    const keepOwn = (await post('a', { targetRole: 'Front-End Developer', cvContent: SAMPLE_CV, fileName: 'keep-a.txt' })).body.data.id as number;
    const keepOther = (await post('b', { targetRole: 'Front-End Developer', cvContent: SAMPLE_CV, fileName: 'keep-b.txt' })).body.data.id as number;
    const [logBefore] = await prisma.llmUsageLog.findMany({ where: { runId: target.runId } });

    const res = await del('admin', target.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: target.id });

    expect(await prisma.skillsGapAnalysis.count({ where: { id: target.id } })).toBe(0);
    expect((await get('a', `/api/skills-gap/analyses/${target.id}`)).status).toBe(404);
    expect(((await get('a', '/api/skills-gap/analyses')).body.data as Array<{ id: number }>).map(a => a.id)).not.toContain(target.id);
    expect(((await get('admin', '/api/skills-gap/analyses')).body.data as Array<{ id: number }>).map(a => a.id)).not.toContain(target.id);

    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: target.runId } })).toMatchObject({ status: 'SUCCESS' });
    expect(await prisma.llmUsageLog.findUniqueOrThrow({ where: { id: logBefore.id } })).toEqual(logBefore);
    expect(await prisma.skillsGapAnalysis.count({ where: { id: { in: [keepOwn, keepOther] } } })).toBe(2);
  });

  it('refuses every regular user with 403 - the owner included, whatever the request claims - and deletes nothing', async () => {
    const id = (await post('a', { targetRole: 'Front-End Developer', cvContent: SAMPLE_CV })).body.data.id as number;
    const own = await del('a', id);
    expect(own.status).toBe(403);
    expect(own.body.error).toMatch(/Admin access required/);
    expect((await del('b', id)).status).toBe(403);
    expect((await del('a', id).query({ userId: uid.b, role: 'admin' }).send({ role: 'admin', userId: uid.b })).status).toBe(403);
    expect((await del('a', 999999999)).status).toBe(403); // refused before any lookup
    expect(await prisma.skillsGapAnalysis.count({ where: { id } })).toBe(1);
  });

  it('fails safely without a session and for unknown or invalid ids', async () => {
    const id = (await post('a', { targetRole: 'Front-End Developer', cvContent: SAMPLE_CV })).body.data.id as number;
    expect((await del(null, id)).status).toBe(401);
    expect((await del('admin', 999999999)).status).toBe(404);
    expect((await del('admin', 'abc')).status).toBe(400);
    expect(await prisma.skillsGapAnalysis.count({ where: { id } })).toBe(1);
  });
});

describe('PSS and DCS target roles', () => {
  for (const [role, label, cv, ownSkill] of [
    ['PSS', 'Passenger Service System', PSS_CV, 'PSS platforms (e.g. Amadeus Altea, Sabre, Navitaire)'],
    ['DCS', 'Departure Control System', DCS_CV, 'Load control concepts'],
  ] as const) {
    it(`${role}: submitted, analyzed against its own skills, saved and retrieved with the stable id`, async () => {
      const requests: LLMProviderRequest[] = [];
      __setSkillsGapAgentForTesting(new SkillsGapAgent(new LLMService({ messages: { create: async req => { requests.push(req); return { content: [{ type: 'text', text: JSON.stringify(analysisFor(role, cv, roleConfig)) }], model: 'gpt-4o', usage: REAL_USAGE }; } } })));
      const res = await post('a', { targetRole: role, cvContent: cv, fileName: `${role.toLowerCase()}.txt` });
      expect(res.status).toBe(201);
      expect(requests).toHaveLength(1);
      expect(requests[0].system).toContain(`target role "${role}" (${label})`);
      expect(requests[0].system).toContain(`"${ownSkill}"`);
      expect(requests[0].system).not.toContain('Component framework'); // no other role's skills
      const saved = (await get('a', `/api/skills-gap/analyses/${res.body.data.id}`)).body.data;
      expect(saved.targetRole).toBe(role);
      const all = [...saved.result.demonstratedSkills, ...saved.result.potentialGaps].map((s: { skill: string }) => s.skill).sort();
      expect(all).toEqual(roleConfig.ROLE_REQUIREMENTS[role].skills.map(s => s.name).sort());
      expect(saved.result.demonstratedSkills.length).toBeGreaterThan(0);
      expect(saved.result.potentialGaps.find((g: { skill: string }) => g.skill === ownSkill).priority).toBe('Medium');
    });
  }

  it("rejects an analysis that uses another role's skills (each role keeps its own requirements)", async () => {
    useModel(() => JSON.stringify({ ...validAnalysis(), targetRole: 'PSS' }));
    const res = await post('a', { targetRole: 'PSS', cvContent: PSS_CV });
    expect(res.status).toBe(502);
  });

  it('rejects invalid role values, including lowercase or full-name variants of the ids', async () => {
    for (const targetRole of ['pss', 'Passenger Service System', 'DCS ', 42]) {
      expect((await post('a', { targetRole, cvContent: PSS_CV })).status).toBe(400);
    }
  });
});

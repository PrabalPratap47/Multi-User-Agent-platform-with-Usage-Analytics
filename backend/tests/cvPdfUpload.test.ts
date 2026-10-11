import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import bcryptjs from 'bcryptjs';
import request from 'supertest';
import { app, loginAs, TEST_PASSWORD } from './helpers.js';
import prisma from '../src/db/client.js';
import config from '../src/config/env.js';
import {
  CVClassificationAgent,
  cvClassificationAgent as realCvClassificationAgent,
  __setCvClassificationAgentForTesting,
  CV_CLASSIFICATION_AGENT_NAME,
} from '../src/agents/CVClassificationAgent.js';
import { LLMService, type LLMProviderClient, type LLMProviderRequest } from '../src/services/llmService.js';
import { CV_CATEGORIES } from '../src/utils/validators.js';
import { extractPdfText, MAX_PDF_BYTES, __setPdfExtractionTimeoutForTesting } from '../src/utils/pdfText.js';
import { corruptedPdf, encryptedPdf, imageOnlyPdf, textPdf, toBase64 } from './fixtures/pdfFixtures.js';
import { cvFeedbackFrom } from './fixtures/cvFeedback.js';

/**
 * PDF CV upload: text extraction (real PDF.js in its worker thread, real
 * PDF files built by fixtures/pdfFixtures.ts) feeding the existing
 * classification workflow. The AI provider is a stub that records what it
 * was sent and returns fixed token usage, so usage logging is checked too.
 */

const EMAIL = { a: 'cv-pdf-user-a@test.local', b: 'cv-pdf-user-b@test.local', admin: 'cv-pdf-admin@test.local' } as const;
const token = { a: '', b: '', admin: '' };
const LIMITS = { minChars: 10, maxChars: 50_000 };
const PDF_TIMEOUT = 60_000;

const VALID_PDF = textPdf([
  ['Jane Doe - Back-End Developer', '6 years building REST APIs with Node.js, Express and PostgreSQL.'],
  ['Page two: led a team of 4 backend engineers.'],
]);
const SECOND_PDF = textPdf([['Sam Lee - Back-End Developer', 'Built payment services in Node.js and Express for 5 years.']]);
const TXT_CV = 'Alex Kim - backend engineer with 5 years of Node.js and Express REST API work.';

const providerRequests: LLMProviderRequest[] = [];

function stubAgent(): CVClassificationAgent {
  const confidence: Record<string, number> = Object.fromEntries(CV_CATEGORIES.map(c => [c, 0]));
  confidence['Back-End Developer'] = 0.9;
  const client: LLMProviderClient = {
    messages: {
      create: async (req: LLMProviderRequest) => {
        providerRequests.push(req);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                primaryCategory: 'Back-End Developer',
                secondaryCategories: [],
                confidence,
                rationale: [{ category: 'Back-End Developer', evidence: 'Node.js and Express' }],
                feedback: cvFeedbackFrom('Node.js and Express'),
              }),
            },
          ],
          model: 'gpt-4o',
          usage: { prompt_tokens: 321, completion_tokens: 45 },
        };
      },
    },
  };
  return new CVClassificationAgent(new LLMService(client));
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { in: Object.values(EMAIL) } }, select: { id: true } });
  const userId = { in: users.map(u => u.id) };
  await prisma.recommendationDecision.deleteMany({ where: { userId } });
  await prisma.cvRecommendation.deleteMany({ where: { userId } });
  await prisma.cvDocument.deleteMany({ where: { userId } });
  await prisma.llmUsageLog.deleteMany({ where: { userId } });
  await prisma.agentRun.deleteMany({ where: { userId } });
  await prisma.refreshToken.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAIL) } } });
}

beforeAll(async () => {
  await cleanup();
  await prisma.agent.upsert({
    where: { name: CV_CLASSIFICATION_AGENT_NAME },
    update: {},
    create: { name: CV_CLASSIFICATION_AGENT_NAME, description: 'Upserted for tests', version: '1.0.0' },
  });
  const password = await bcryptjs.hash(TEST_PASSWORD, config.BCRYPT_SALT_ROUNDS);
  await prisma.user.create({ data: { email: EMAIL.a, password, role: 'USER' } });
  await prisma.user.create({ data: { email: EMAIL.b, password, role: 'USER' } });
  await prisma.user.create({ data: { email: EMAIL.admin, password, role: 'ADMIN' } });
  token.a = (await loginAs(EMAIL.a)).accessToken;
  token.b = (await loginAs(EMAIL.b)).accessToken;
  token.admin = (await loginAs(EMAIL.admin)).accessToken;
  __setCvClassificationAgentForTesting(stubAgent());
});

afterAll(async () => {
  __setCvClassificationAgentForTesting(realCvClassificationAgent);
  __setPdfExtractionTimeoutForTesting();
  await cleanup();
});

const post = (who: keyof typeof token, path: string, body: object) =>
  request(app).post(path).set('Authorization', `Bearer ${token[who]}`).send(body);
const get = (who: keyof typeof token, path: string) => request(app).get(path).set('Authorization', `Bearer ${token[who]}`);

async function waitForBatch(batchId: string) {
  const start = Date.now();
  while (Date.now() - start < PDF_TIMEOUT) {
    const res = await get('a', `/api/cv/batch/${batchId}/status`);
    if (res.body.data.queued + res.body.data.processing === 0) return res.body.data;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('batch did not finish');
}

/** The CV text the provider received, between the prompt's untrusted-data markers. */
function cvTextSent(req: LLMProviderRequest): string {
  const content = req.messages[0].content;
  return content.slice(content.indexOf('[CV TEXT - BEGIN'), content.indexOf('[CV TEXT - END]'));
}

describe('extractPdfText', () => {
  it('extracts readable text from every page of a text-based PDF', async () => {
    const text = await extractPdfText(toBase64(VALID_PDF), LIMITS);
    expect(text).toBe(
      'Jane Doe - Back-End Developer\n6 years building REST APIs with Node.js, Express and PostgreSQL.\nPage two: led a team of 4 backend engineers.'
    );
  }, PDF_TIMEOUT);

  const rejected: Array<[string, () => string, RegExp]> = [
    ['an empty file', () => '', /The PDF file is empty/],
    ['a file larger than 2 MB', () => toBase64(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(MAX_PDF_BYTES)])), /larger than the 2 MB limit/],
    ['content that is not base64', () => 'this is not base64!', /could not be decoded/],
    ['a text file renamed to .pdf (no PDF signature)', () => toBase64(Buffer.from(TXT_CV)), /not a PDF \(it has no PDF header\)/],
    ['a corrupted PDF', () => toBase64(corruptedPdf()), /damaged or not a valid PDF/],
    ['a truncated PDF', () => toBase64(VALID_PDF.subarray(0, Math.floor(VALID_PDF.length / 2))), /damaged or not a valid PDF/],
    ['a password-protected PDF', () => toBase64(encryptedPdf('secret')), /password-protected/],
    ['an encrypted PDF that opens without a password', () => toBase64(encryptedPdf('')), /The PDF is encrypted/],
    ['a scanned PDF with no extractable text', () => toBase64(imageOnlyPdf()), /No readable text.*OCR\) is not supported/],
    ['a PDF with more than 50 pages', () => toBase64(textPdf(Array.from({ length: 51 }, (_, i) => [`Page ${i + 1} text`]))), /more than 50 pages/],
    [
      'a PDF with more than 50,000 characters of text',
      () => toBase64(textPdf(Array.from({ length: 30 }, () => Array.from({ length: 50 }, () => 'x'.repeat(40))))),
      /more than 50,000 characters/,
    ],
  ];
  for (const [name, input, message] of rejected) {
    it(`rejects ${name} with a clear message`, async () => {
      await expect(extractPdfText(input(), LIMITS)).rejects.toThrow(message);
    }, PDF_TIMEOUT);
  }

  it('stops a PDF that takes longer than the processing time limit', async () => {
    __setPdfExtractionTimeoutForTesting(1);
    try {
      await expect(extractPdfText(toBase64(VALID_PDF), LIMITS)).rejects.toThrow(/took longer than 15 seconds and was stopped/);
    } finally {
      __setPdfExtractionTimeoutForTesting();
    }
    // The next PDF is processed normally.
    await expect(extractPdfText(toBase64(VALID_PDF), LIMITS)).resolves.toContain('Jane Doe');
  }, PDF_TIMEOUT);
});

describe('POST /api/cv/classify with one PDF', () => {
  afterEach(() => {
    providerRequests.length = 0;
  });

  it('classifies a text-based PDF through the existing workflow, storing only the extracted text, with usage logged', async () => {
    const res = await post('a', '/api/cv/classify', { pdfBase64: toBase64(VALID_PDF), fileName: 'jane.pdf' });
    expect(res.status).toBe(201);
    expect(res.body.data.primaryCategory).toBe('Back-End Developer');

    const doc = await prisma.cvDocument.findUnique({ where: { id: res.body.data.cvDocumentId } });
    expect(doc!.fileName).toBe('jane.pdf');
    expect(doc!.content).toContain('6 years building REST APIs with Node.js');
    expect(doc!.content).not.toContain('%PDF');

    expect(providerRequests).toHaveLength(1);
    expect(cvTextSent(providerRequests[0])).toContain('Page two: led a team of 4 backend engineers.');

    const logs = await prisma.llmUsageLog.findMany({ where: { runId: res.body.data.runId } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ userId: doc!.userId, inputTokens: 321, outputTokens: 45, status: 'SUCCESS', isSeedData: false });
  }, PDF_TIMEOUT);

  it('rejects a scanned PDF with a 400 and the OCR message, before storing anything or calling the AI', async () => {
    const documentsBefore = await prisma.cvDocument.count();
    const res = await post('a', '/api/cv/classify', { pdfBase64: toBase64(imageOnlyPdf()), fileName: 'scan.pdf' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/OCR\) is not supported/);
    expect(providerRequests).toHaveLength(0);
    expect(await prisma.cvDocument.count()).toBe(documentsBefore);
  }, PDF_TIMEOUT);

  it('still classifies a .txt CV sent as text, unchanged', async () => {
    const res = await post('a', '/api/cv/classify', { cvContent: TXT_CV, fileName: 'alex.txt' });
    expect(res.status).toBe(201);
    expect(cvTextSent(providerRequests[0])).toContain(TXT_CV);
    expect((await prisma.cvDocument.findUnique({ where: { id: res.body.data.cvDocumentId } }))!.content).toBe(TXT_CV);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/cv/classify').send({ pdfBase64: toBase64(VALID_PDF), fileName: 'jane.pdf' });
    expect(res.status).toBe(401);
    expect(providerRequests).toHaveLength(0);
  });
});

describe('POST /api/cv/batch with mixed PDF and TXT files', () => {
  let batchId = '';
  let status: { total: number; completed: number; failed: number; items: Array<{ fileName: string; state: string; error: string | null; recommendationId: number | null; runId: string; documentId: number }> };

  beforeAll(async () => {
    providerRequests.length = 0;
    const pdf = (fileName: string, bytes: Buffer) => ({ fileName, mimeType: 'application/pdf', content: toBase64(bytes) });
    const res = await post('a', '/api/cv/batch', {
      files: [
        pdf('jane.pdf', VALID_PDF),
        { fileName: 'alex.txt', mimeType: 'text/plain', content: TXT_CV },
        pdf('scan.pdf', imageOnlyPdf()),
        pdf('locked.pdf', encryptedPdf('secret')),
        pdf('broken.pdf', corruptedPdf()),
        pdf('renamed.pdf', Buffer.from(TXT_CV)),
        { fileName: 'empty.pdf', mimeType: 'application/pdf', content: '' },
        pdf('sam.pdf', SECOND_PDF),
        { fileName: 'cv.doc', mimeType: 'application/msword', content: TXT_CV },
      ],
    });
    expect(res.status).toBe(202);
    batchId = res.body.data.batchId;
    status = await waitForBatch(batchId);
  }, PDF_TIMEOUT * 2);

  afterAll(() => {
    providerRequests.length = 0;
  });

  it('classifies the valid PDFs and the TXT, and fails each bad file on its own with a clear reason', () => {
    const byName = Object.fromEntries(status.items.map(i => [i.fileName, i]));
    expect(status).toMatchObject({ total: 9, completed: 3, failed: 6 });
    for (const ok of ['jane.pdf', 'alex.txt', 'sam.pdf']) expect(byName[ok]).toMatchObject({ state: 'completed', error: null });
    expect(byName['scan.pdf'].error).toMatch(/No readable text.*OCR\) is not supported/);
    expect(byName['locked.pdf'].error).toMatch(/password-protected/);
    expect(byName['broken.pdf'].error).toMatch(/damaged or not a valid PDF/);
    expect(byName['renamed.pdf'].error).toMatch(/not a PDF/);
    expect(byName['empty.pdf'].error).toMatch(/empty/);
    expect(byName['cv.doc'].error).toMatch(/Unsupported file type "application\/msword"/);
    for (const item of status.items) expect(item.error ?? '').not.toMatch(/[A-Za-z]:\\|\/Users\/|\.ts:|\n\s+at /);
  });

  it('sends only the valid files to the AI, once each, with usage logged per run', async () => {
    expect(providerRequests).toHaveLength(3);
    const sent = providerRequests.map(cvTextSent).join('\n');
    expect(sent).toContain('6 years building REST APIs');
    expect(sent).toContain(TXT_CV);
    expect(sent).toContain('Built payment services in Node.js');

    const completedRuns = status.items.filter(i => i.state === 'completed').map(i => i.runId);
    const logs = await prisma.llmUsageLog.findMany({ where: { runId: { in: status.items.map(i => i.runId) } } });
    expect(logs.map(l => l.runId).sort()).toEqual([...completedRuns].sort());
    expect(logs.every(l => l.inputTokens === 321 && l.outputTokens === 45 && l.status === 'SUCCESS')).toBe(true);
  });

  it('stores extracted text for PDFs (never the upload) and the TXT content unchanged', async () => {
    const byName = Object.fromEntries(status.items.map(i => [i.fileName, i]));
    const content = async (name: string) => (await prisma.cvDocument.findUnique({ where: { id: byName[name].documentId } }))!.content;
    expect(await content('jane.pdf')).toContain('Page two: led a team of 4 backend engineers.');
    expect(await content('alex.txt')).toBe(TXT_CV);
    expect(await content('scan.pdf')).toBe('');
    expect(await content('locked.pdf')).toBe('');
  });

  it("keeps user isolation (403 for another user) and admin access", async () => {
    const janeRec = status.items.find(i => i.fileName === 'jane.pdf')!.recommendationId!;
    expect((await get('b', `/api/cv/batch/${batchId}/status`)).status).toBe(403);
    expect((await get('b', `/api/cv/results/${janeRec}`)).status).toBe(403);
    expect(((await get('b', '/api/cv/results')).body.data as Array<{ id: number }>).some(r => r.id === janeRec)).toBe(false);
    expect((await get('admin', `/api/cv/results/${janeRec}`)).status).toBe(200);
    expect((await get('admin', `/api/cv/batch/${batchId}/status`)).status).toBe(200);
  });
});

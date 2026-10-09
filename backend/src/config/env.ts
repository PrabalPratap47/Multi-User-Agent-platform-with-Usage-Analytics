import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env.test when running under the test runner, otherwise .env.local
dotenv.config({ path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env.local' });

/**
 * JWT_SECRET values published in this repository's templates and docs.
 * Anyone can read them, so a server signing tokens with one would accept
 * tokens forged by anybody. Never add a real secret here.
 */
export const KNOWN_PLACEHOLDER_JWT_SECRETS: readonly string[] = [
  'your_jwt_secret_here_minimum_32_chars', // backend/.env.example
  "your_jwt_secret_here_generate_with_crypto.randomBytes(32).toString('hex')", // .env.example
  'your_super_secret_key_minimum_32_characters_long', // SETUP.md example
];

/**
 * backend/.env.test.example's value. Accepted only with NODE_ENV=test, where
 * it signs tokens for the throwaway test database; refused everywhere else.
 */
export const TEST_TEMPLATE_JWT_SECRET = 'test_jwt_secret_minimum_32_characters_long_xx';

const GENERATE_HINT = `generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;

/**
 * Why `secret` is unusable, or null if it is acceptable. The message never
 * contains the value itself, so it is safe to print at startup.
 */
export function jwtSecretProblem(secret: string | undefined, nodeEnv: string | undefined): string | null {
  if (secret === undefined) return `is required - ${GENERATE_HINT}`;
  const value = secret.trim();
  if (value.length === 0) return `must not be blank - ${GENERATE_HINT}`;
  if (value.length < 32) return `must be at least 32 characters, not counting surrounding whitespace - ${GENERATE_HINT}`;
  // Exact template values, plus any "your_..." fill-in-the-blank variant of them.
  if (KNOWN_PLACEHOLDER_JWT_SECRETS.includes(value) || /^your[_-]/i.test(value)) {
    return `is a placeholder from the example env file or docs, not a secret - ${GENERATE_HINT}`;
  }
  if (value === TEST_TEMPLATE_JWT_SECRET && nodeEnv !== 'test') {
    return `is the published test-only value from .env.test.example and is only accepted with NODE_ENV=test - ${GENERATE_HINT}`;
  }
  return null;
}

const envSchema = z.object({
  // Server
  BACKEND_PORT: z.string().default('3001').pipe(z.coerce.number()),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Frontend
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),

  // Database
  DATABASE_URL: z.string(),

  // Authentication (content rules: jwtSecretProblem, applied below)
  JWT_SECRET: z.string({ required_error: `is required - ${GENERATE_HINT}` }),
  // Expressed in SECONDS (jsonwebtoken's `expiresIn` treats a bare number as seconds)
  JWT_EXPIRY_SECONDS: z.string().pipe(z.coerce.number()).default('900'), // 15 minutes
  REFRESH_TOKEN_EXPIRY_SECONDS: z.string().pipe(z.coerce.number()).default('604800'), // 7 days
  BCRYPT_SALT_ROUNDS: z.string().pipe(z.coerce.number()).default('12'),

  // LLM
  // May be empty: the server still starts, and LLM calls fail with
  // OPENAI_API_KEY_MISSING (logged as an ERROR usage row) until it is set.
  OPENAI_API_KEY: z.string().default(''),
  // The single place the model is chosen; LLMService uses it for every call.
  OPENAI_MODEL: z.string().trim().min(1).default('gpt-4o'),
  // Per-user limit on AI runs started through the API (a batch counts one
  // run per file), over a sliding window. See middleware/aiRateLimit.ts.
  AI_RATE_LIMIT_MAX_RUNS: z.string().default('60').pipe(z.coerce.number().int().min(1)),
  AI_RATE_LIMIT_WINDOW_SECONDS: z.string().default('600').pipe(z.coerce.number().int().min(1)),

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
}).superRefine((env, ctx) => {
  const problem = jwtSecretProblem(env.JWT_SECRET, env.NODE_ENV);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['JWT_SECRET'], message: problem });
});

type Env = z.infer<typeof envSchema>;

let config: Env;

try {
  config = envSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error('Invalid environment variables:');
    error.errors.forEach(e => {
      console.error(`  ${e.path.join('.')}: ${e.message}`);
    });
    process.exit(1);
  }
  throw error;
}

export default config;

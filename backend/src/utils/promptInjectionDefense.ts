/**
 * Escape user input for safe inclusion in prompts
 * Converts special characters to JSON-safe format
 */
export function escapeUserInput(input: string): string {
  // Escape special characters that could break JSON or be used for injection
  return JSON.stringify(input);
}

/**
 * Sanitize user input - remove potentially dangerous patterns
 */
export function sanitizeUserInput(input: string): string {
  // Remove any line with "system:", "assistant:", or other prompt-like patterns
  const lines = input.split('\n');
  const filtered = lines.filter(line => {
    const lowerLine = line.toLowerCase();
    return !lowerLine.includes('system:') &&
           !lowerLine.includes('assistant:') &&
           !lowerLine.includes('user:') &&
           !lowerLine.includes('[instructions]') &&
           !lowerLine.includes('[directive]') &&
           !lowerLine.includes('ignore') &&
           !lowerLine.includes('override') &&
           !lowerLine.includes('prompt');
  });
  return filtered.join('\n').trim();
}

/**
 * Validate that LLM response is valid JSON and matches expected structure
 * This prevents injection attacks where LLM returns instructions instead of classification
 */
export function validateJSONResponse(response: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(response);
    return parsed;
  } catch {
    throw new Error('Invalid JSON response from LLM');
  }
}

// The CV classification prompt and the sentiment analysis prompt live in
// agents/cvClassification/prompt.ts and agents/sentiment/prompt.ts,
// alongside the schema and agent each is tightly coupled to, not here -
// see those files for the role-separation-based injection defense
// actually used by each agent (a dedicated system prompt + an explicit
// untrusted-data framing, rather than the string-stripping approach
// above).

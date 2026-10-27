/** Cut text to at most `max` characters, marking the cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Compile user-supplied patterns once. Throws a readable error for a bad pattern. */
export function compilePatterns(patterns: readonly string[], what: string): RegExp[] {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern, 'g');
    } catch (error) {
      throw new Error(
        `${what}: invalid regular expression ${JSON.stringify(pattern)} (${errorMessage(error)})`,
      );
    }
  });
}

export function redact(text: string, patterns: readonly RegExp[]): string {
  let out = text;
  for (const pattern of patterns) out = out.replace(pattern, '[redacted]');
  return out;
}

/** Longest run of backticks in `text`, used to pick a Markdown fence that cannot be closed early. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

export function fenced(text: string): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}text\n${text}\n${fence}`;
}

import { ProviderError } from '../errors';
import { errorMessage, sleep as realSleep, truncate } from '../util/text';

export interface HttpDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export const defaultHttpDeps: HttpDeps = {
  fetch: (...args) => fetch(...args),
  sleep: realSleep,
  random: Math.random,
};

export interface PostOptions {
  label: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  maxRetries: number;
  /** Secret strings that must never appear in an error message. */
  secrets: string[];
}

const RETRYABLE = new Set([408, 409, 425, 429]);
const MAX_WAIT_MS = 60_000;

function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  return out;
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(MAX_WAIT_MS, Math.max(0, seconds * 1000));
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(MAX_WAIT_MS, Math.max(0, date - Date.now()));
  return undefined;
}

/** POSTs JSON, retrying rate limits, overloads and network faults with backoff and jitter. */
export async function postJson(options: PostOptions, deps: HttpDeps): Promise<unknown> {
  let lastProblem = 'no attempt was made';
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    let waitMs = Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + deps.random() / 2);
    try {
      const response = await deps.fetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (response.ok) return await response.json();

      const text = await response.text().catch(() => '');
      lastStatus = response.status;
      lastProblem = `${options.label} API error ${response.status}: ${scrub(truncate(text, 300), options.secrets)}`;
      const retryable = RETRYABLE.has(response.status) || response.status >= 500;
      if (!retryable) throw new ProviderError(lastProblem, response.status);
      waitMs = retryAfterMs(response.headers.get('retry-after')) ?? waitMs;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      lastStatus = undefined;
      lastProblem = `${options.label} request failed: ${scrub(errorMessage(error), options.secrets)}`;
    }
    if (attempt < options.maxRetries) await deps.sleep(waitMs);
  }
  throw new ProviderError(
    `${lastProblem} (gave up after ${options.maxRetries + 1} attempts)`,
    lastStatus,
  );
}

import { describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../src/config/types';
import { BudgetExceededError, MissingSecretError, ProviderError } from '../src/errors';
import { createProvider } from '../src/providers';
import { CallBudget } from '../src/providers/budget';
import type { HttpDeps } from '../src/providers/http';
import type { ProviderMeta } from '../src/providers/types';

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function setup(responses: Array<Response | Error>) {
  const queue = [...responses];
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra request');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async (_ms: number) => {});
  const http: Partial<HttpDeps> = {
    fetch: fetchMock as unknown as typeof fetch,
    sleep,
    random: () => 1,
  };
  return { fetchMock, sleep, http };
}

const anthropic: ProviderConfig = { type: 'anthropic', model: 'claude-haiku-5-5' };
const headersOf = (init?: RequestInit) => (init?.headers ?? {}) as Record<string, string>;
const bodyOf = (mock: ReturnType<typeof setup>['fetchMock'], call = 0) =>
  JSON.parse(String(mock.mock.calls[call]?.[1]?.body));

function make(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv,
  http: Partial<HttpDeps>,
  max?: number,
) {
  return createProvider(config, { env, budget: new CallBudget(max), seed: 's', http });
}

describe('anthropic provider', () => {
  const ok = {
    model: 'claude-haiku-5-5-20261001',
    content: [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
    ],
    usage: { input_tokens: 11, output_tokens: 3 },
  };

  it('sends a Messages API request and reads the reply', async () => {
    const { fetchMock, http } = setup([reply(ok)]);
    const provider = make(
      { ...anthropic, max_tokens: 99, temperature: 0.2 },
      { ANTHROPIC_API_KEY: 'sk-test-1234' },
      http,
    );

    const out = await provider.complete({ system: 'Be brief', prompt: 'Hi' });

    expect(out).toMatchObject({
      text: 'Hello world',
      model: 'claude-haiku-5-5-20261001',
      usage: { input_tokens: 11, output_tokens: 3 },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(headersOf(init)['x-api-key']).toBe('sk-test-1234');
    expect(headersOf(init)['anthropic-version']).toBe('2023-06-01');
    expect(bodyOf(fetchMock)).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 99,
      temperature: 0.2,
      system: 'Be brief',
      messages: [{ role: 'user', content: 'Hi' }],
    });
  });

  it('leaves temperature out unless asked, and when it is null', async () => {
    for (const temperature of [undefined, null]) {
      const { fetchMock, http } = setup([reply(ok)]);
      await make({ ...anthropic, temperature }, { ANTHROPIC_API_KEY: 'k' }, http).complete({
        prompt: 'Hi',
      });
      expect(bodyOf(fetchMock)).not.toHaveProperty('temperature');
      expect(bodyOf(fetchMock)).not.toHaveProperty('system');
    }
  });

  it('retries an overloaded API and then succeeds', async () => {
    const { fetchMock, sleep, http } = setup([reply({ error: 'overloaded' }, 529), reply(ok)]);
    const out = await make(anthropic, { ANTHROPIC_API_KEY: 'k' }, http).complete({ prompt: 'Hi' });
    expect(out.text).toBe('Hello world');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('waits as long as Retry-After says', async () => {
    const { sleep, http } = setup([reply({}, 429, { 'retry-after': '3' }), reply(ok)]);
    await make(anthropic, { ANTHROPIC_API_KEY: 'k' }, http).complete({ prompt: 'Hi' });
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('retries a dropped connection', async () => {
    const { fetchMock, http } = setup([new TypeError('fetch failed'), reply(ok)]);
    await make(anthropic, { ANTHROPIC_API_KEY: 'k' }, http).complete({ prompt: 'Hi' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after max_retries and says so', async () => {
    const { fetchMock, http } = setup([reply({}, 500), reply({}, 500), reply({}, 500)]);
    const provider = make({ ...anthropic, max_retries: 2 }, { ANTHROPIC_API_KEY: 'k' }, http);
    await expect(provider.complete({ prompt: 'Hi' })).rejects.toThrow(/gave up after 3 attempts/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a request the API rejects, and never leaks the key', async () => {
    const key = 'sk-ant-very-secret-key-0001';
    const { fetchMock, http } = setup([reply({ error: { message: `invalid key ${key}` } }, 401)]);
    const failure = await make(anthropic, { ANTHROPIC_API_KEY: key }, http)
      .complete({ prompt: 'Hi' })
      .catch((error: unknown) => error as ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).status).toBe(401);
    expect((failure as ProviderError).message).not.toContain(key);
    expect((failure as ProviderError).message).toContain('[redacted]');
  });
});

describe('openai-compatible provider', () => {
  const ok = {
    model: 'gpt-x-2026',
    choices: [{ message: { content: 'Hi there' } }],
    usage: { prompt_tokens: 7, completion_tokens: 2 },
  };

  it('uses chat completions with a bearer key and max_completion_tokens on OpenAI', async () => {
    const { fetchMock, http } = setup([reply(ok)]);
    const out = await make(
      { type: 'openai', model: 'gpt-x', max_tokens: 50 },
      { OPENAI_API_KEY: 'sk-oa' },
      http,
    ).complete({
      system: 'sys',
      prompt: 'Hi',
    });
    expect(out).toMatchObject({
      text: 'Hi there',
      model: 'gpt-x-2026',
      usage: { input_tokens: 7, output_tokens: 2 },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(headersOf(init).authorization).toBe('Bearer sk-oa');
    expect(bodyOf(fetchMock)).toEqual({
      model: 'gpt-x',
      max_completion_tokens: 50,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Hi' },
      ],
    });
  });

  it('talks to a local server without a key, using max_tokens', async () => {
    const { fetchMock, http } = setup([reply(ok)]);
    const config: ProviderConfig = {
      type: 'openai',
      model: 'llama3',
      base_url: 'http://localhost:11434/v1/',
    };
    await make(config, {}, http).complete({ prompt: 'Hi' });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(init?.headers).not.toHaveProperty('authorization');
    expect(bodyOf(fetchMock)).toHaveProperty('max_tokens', 1024);
  });

  it('reports an answer with no choices as an error', async () => {
    const { http } = setup([reply({ choices: [] })]);
    await expect(
      make({ type: 'openai', model: 'm' }, { OPENAI_API_KEY: 'k' }, http).complete({
        prompt: 'Hi',
      }),
    ).rejects.toThrow('no choices');
  });
});

describe('createProvider', () => {
  it('names the missing key', () => {
    expect(() => make(anthropic, {}, {})).toThrow(MissingSecretError);
    expect(() => make({ type: 'openai', model: 'm', api_key_env: 'CUSTOM' }, {}, {})).toThrow(
      '`CUSTOM`',
    );
  });

  it('stops at the call budget', async () => {
    const provider = make({ type: 'mock' }, {}, {}, 2);
    await provider.complete({ prompt: 'a' });
    await provider.complete({ prompt: 'b' });
    await expect(provider.complete({ prompt: 'c' })).rejects.toThrow(BudgetExceededError);
  });
});

describe('mock provider', () => {
  const meta = (
    id: string,
    trial = 0,
    role: ProviderMeta['role'] = 'target',
    candidate?: string,
  ): ProviderMeta => ({
    role,
    trial,
    candidate,
    row: { id, vars: {}, expected: 'The answer' },
  });
  const ask = (config: ProviderConfig, prompt: string, m: ProviderMeta) =>
    make(config, {}, {}).complete({ prompt, meta: m });

  it('repeats exactly for the same case and trial, and varies across trials', async () => {
    const config: ProviderConfig = { type: 'mock', accuracy: 0.5 };
    const a = await Promise.all(
      Array.from({ length: 30 }, (_, t) => ask(config, 'q', meta('c', t))),
    );
    const b = await Promise.all(
      Array.from({ length: 30 }, (_, t) => ask(config, 'q', meta('c', t))),
    );
    expect(a.map((x) => x.text)).toEqual(b.map((x) => x.text));
    expect(new Set(a.map((x) => x.text)).size).toBeGreaterThan(1);
  });

  it('follows the accuracy marker in the prompt over the configured one', async () => {
    const config: ProviderConfig = { type: 'mock', accuracy: 0.5 };
    const hit = async (prompt: string) => {
      const answers = await Promise.all(
        Array.from({ length: 200 }, (_, i) => ask(config, prompt, meta(`c${i}`))),
      );
      return answers.filter((x) => x.text === 'The answer').length / 200;
    };
    expect(await hit('mock-accuracy: 1')).toBe(1);
    expect(await hit('mock-accuracy: 0')).toBe(0);
    expect(await hit('no marker')).toBeGreaterThan(0.35);
    expect(await hit('no marker')).toBeLessThan(0.65);
  });

  it('judges a candidate that contains the expected text higher', async () => {
    const judge = (candidate: string) =>
      ask({ type: 'mock' }, 'Give an integer from 1 to 5.', meta('c', 0, 'judge', candidate));
    const good = JSON.parse((await judge('Surely the answer is: The answer.')).text);
    const bad = JSON.parse((await judge('No idea')).text);
    expect(good.score).toBeGreaterThanOrEqual(4);
    expect(bad.score).toBeLessThanOrEqual(3);
  });
});

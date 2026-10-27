import type { ProviderConfig } from '../config/types';
import { ProviderError } from '../errors';
import { type HttpDeps, postJson } from './http';
import type { Completion, CompletionRequest, Provider } from './types';

interface AnthropicResponse {
  model?: string;
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function anthropicProvider(
  config: ProviderConfig,
  apiKey: string,
  deps: HttpDeps,
): Provider {
  const base = (config.base_url ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const model = config.model as string;

  return {
    id: `anthropic:${model}`,
    async complete(request: CompletionRequest): Promise<Completion> {
      const body: Record<string, unknown> = {
        model,
        max_tokens: config.max_tokens ?? 1024,
        messages: [{ role: 'user', content: request.prompt }],
      };
      if (request.system) body.system = request.system;
      if (config.temperature !== undefined && config.temperature !== null) {
        body.temperature = config.temperature;
      }

      const started = performance.now();
      const json = (await postJson(
        {
          label: 'Anthropic',
          url: `${base}/v1/messages`,
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body,
          timeoutMs: config.timeout_ms ?? 120_000,
          maxRetries: config.max_retries ?? 4,
          secrets: [apiKey],
        },
        deps,
      )) as AnthropicResponse;

      const text = (json.content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      if (!json.content) throw new ProviderError('Anthropic returned a response with no content');

      return {
        text,
        model: json.model ?? model,
        usage: {
          input_tokens: json.usage?.input_tokens ?? 0,
          output_tokens: json.usage?.output_tokens ?? 0,
        },
        latency_ms: performance.now() - started,
      };
    },
  };
}

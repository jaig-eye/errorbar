import type { ProviderConfig } from '../config/types';
import { ProviderError } from '../errors';
import { type HttpDeps, postJson } from './http';
import type { Completion, CompletionRequest, Provider } from './types';

interface ChatResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function openaiProvider(
  config: ProviderConfig,
  apiKey: string | undefined,
  deps: HttpDeps,
): Provider {
  const base = (config.base_url ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = config.model as string;
  // OpenAI's newer models reject `max_tokens`; most compatible servers only know `max_tokens`.
  const limitField =
    config.max_tokens_param ??
    (config.base_url === undefined || config.base_url.includes('api.openai.com')
      ? 'max_completion_tokens'
      : 'max_tokens');

  return {
    id: `openai:${model}`,
    async complete(request: CompletionRequest): Promise<Completion> {
      const messages: Array<{ role: string; content: string }> = [];
      if (request.system) messages.push({ role: 'system', content: request.system });
      messages.push({ role: 'user', content: request.prompt });

      const body: Record<string, unknown> = {
        model,
        messages,
        [limitField]: config.max_tokens ?? 1024,
      };
      if (config.temperature !== undefined && config.temperature !== null) {
        body.temperature = config.temperature;
      }

      const started = performance.now();
      const json = (await postJson(
        {
          label: 'OpenAI-compatible',
          url: `${base}/chat/completions`,
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          body,
          timeoutMs: config.timeout_ms ?? 120_000,
          maxRetries: config.max_retries ?? 4,
          secrets: apiKey ? [apiKey] : [],
        },
        deps,
      )) as ChatResponse;

      const choice = json.choices?.[0];
      if (!choice) throw new ProviderError('The API returned a response with no choices');

      return {
        text: choice.message?.content ?? '',
        model: json.model ?? model,
        usage: {
          input_tokens: json.usage?.prompt_tokens ?? 0,
          output_tokens: json.usage?.completion_tokens ?? 0,
        },
        latency_ms: performance.now() - started,
      };
    },
  };
}

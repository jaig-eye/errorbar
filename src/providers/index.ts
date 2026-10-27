import { keyRequirement } from '../config/resolve';
import type { ProviderConfig } from '../config/types';
import { MissingSecretError } from '../errors';
import { anthropicProvider } from './anthropic';
import type { CallBudget } from './budget';
import { defaultHttpDeps, type HttpDeps } from './http';
import { mockProvider } from './mock';
import { openaiProvider } from './openai';
import type { Provider } from './types';

export interface ProviderDeps {
  env: NodeJS.ProcessEnv;
  budget: CallBudget;
  /** Seeds the mock provider. */
  seed: string;
  http?: Partial<HttpDeps>;
}

/** Builds a provider. Throws `MissingSecretError` when its API key is not in the environment. */
export function createProvider(config: ProviderConfig, deps: ProviderDeps): Provider {
  const http: HttpDeps = { ...defaultHttpDeps, ...deps.http };
  const need = keyRequirement(config);
  const key = need ? deps.env[need.variable] : undefined;
  if (need?.required && !key) throw new MissingSecretError([need.variable]);

  let inner: Provider;
  switch (config.type) {
    case 'anthropic':
      inner = anthropicProvider(config, key as string, http);
      break;
    case 'openai':
      inner = openaiProvider(config, key, http);
      break;
    case 'mock':
      inner = mockProvider(config, deps.seed);
      break;
  }

  return {
    id: inner.id,
    async complete(request) {
      deps.budget.take();
      return inner.complete(request);
    },
  };
}

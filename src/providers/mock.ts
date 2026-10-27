import type { ProviderConfig } from '../config/types';
import { rngFor } from '../stats/rng';
import type { Completion, CompletionRequest, Provider } from './types';

const WRONG_ANSWERS = [
  'I am not sure about that.',
  'That is outside what I can help with.',
  'Please contact support for details.',
  'I do not have enough information to answer.',
];

/** `mock-accuracy: 0.6` anywhere in the prompt overrides the configured accuracy. */
const MARKER = /mock-accuracy:\s*(0(?:\.\d+)?|1(?:\.0+)?)/;

/**
 * A stand-in for a model, for tests, demos and CI of errorbar itself.
 *
 * As a target it answers with the case's `expected` text with probability `accuracy`, and
 * with a wrong answer otherwise. Change the number in the prompt and you have a regression.
 * As a judge it scores a candidate by whether it contains the expected text.
 * Everything is seeded, so a run is repeatable.
 */
export function mockProvider(config: ProviderConfig, seed: string): Provider {
  const model = config.model ?? 'mock-1';

  return {
    id: `mock:${model}`,
    async complete(request: CompletionRequest): Promise<Completion> {
      const meta = request.meta;
      let text = 'mock response';

      if (meta?.role === 'judge') {
        const scale = Number(/integer from 1 to (\d+)/.exec(request.prompt)?.[1] ?? 5);
        const rng = rngFor(seed, 'judge', meta.row.id, meta.trial);
        const expected = meta.row.expected?.toLowerCase();
        const good =
          expected !== undefined && (meta.candidate ?? '').toLowerCase().includes(expected);
        const score = good
          ? scale - (rng() < 0.1 ? 1 : 0)
          : Math.max(1, Math.round(1 + rng() * (scale - 1) * 0.4));
        text = JSON.stringify({ reasoning: 'mock judge', score });
      } else if (meta) {
        const rng = rngFor(seed, 'target', meta.row.id, meta.trial);
        const accuracy = Number(MARKER.exec(request.prompt)?.[1] ?? config.accuracy ?? 0.8);
        const correct = rng() < accuracy;
        const wrong = WRONG_ANSWERS[Math.floor(rng() * WRONG_ANSWERS.length)] as string;
        text = correct && meta.row.expected !== undefined ? meta.row.expected : wrong;
      }

      return {
        text,
        model,
        usage: {
          input_tokens: Math.ceil(request.prompt.length / 4),
          output_tokens: Math.ceil(text.length / 4),
        },
        latency_ms: 1,
      };
    },
  };
}

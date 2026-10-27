import type { MetricConfig } from '../config/types';
import type { MetricInput } from './types';

type Scorer = (input: MetricInput) => number | null;

function retrievedIds(input: MetricInput): string[] {
  if (!input.contexts) {
    throw new Error(
      'the target returned no `contexts`, so retrieval cannot be scored. Have your command return {"contexts": [{"id": ..., "text": ...}]}',
    );
  }
  return input.contexts.map((context) => context.id);
}

/** Retrieval scorers. Return null for other types. A case without `relevant_ids` does not apply. */
export function retrievalScorer(config: MetricConfig): Scorer | null {
  switch (config.type) {
    case 'recall_at_k':
      return (input) => {
        const relevant = input.row.relevant_ids;
        if (!relevant || relevant.length === 0) return null;
        const top = new Set(retrievedIds(input).slice(0, config.k));
        const hits = relevant.filter((id) => top.has(id)).length;
        return hits / relevant.length;
      };
    case 'mrr':
      return (input) => {
        const relevant = input.row.relevant_ids;
        if (!relevant || relevant.length === 0) return null;
        const wanted = new Set(relevant);
        const ids = retrievedIds(input);
        const limit = config.k ?? ids.length;
        for (let rank = 0; rank < Math.min(limit, ids.length); rank++) {
          if (wanted.has(ids[rank] as string)) return 1 / (rank + 1);
        }
        return 0;
      };
    default:
      return null;
  }
}

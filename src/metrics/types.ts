import type { DatasetRow } from '../dataset';
import type { Completion } from '../providers/types';
import type { MetricMeta } from '../types';

export interface RetrievedContext {
  id: string;
  text: string;
}

export interface MetricInput {
  row: DatasetRow;
  output: string;
  trial: number;
  /** What the target retrieved, in rank order. Only command targets can provide it. */
  contexts?: RetrievedContext[];
}

export interface Metric {
  name: string;
  meta: MetricMeta;
  /**
   * A score in [0, 1], or null when the metric does not apply to this case
   * (for example, the case has no `expected` answer). Throws when it cannot be graded.
   */
  score(input: MetricInput): Promise<number | null>;
}

/** Called for every judge completion, so the runner can count tokens and record model ids. */
export type JudgeUse = (metricName: string, completion: Completion) => void;

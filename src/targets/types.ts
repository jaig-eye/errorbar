import type { DatasetRow } from '../dataset';
import type { RetrievedContext } from '../metrics/types';
import type { Usage } from '../types';

export interface TargetRequest {
  row: DatasetRow;
  trial: number;
}

export interface TargetResponse {
  output: string;
  contexts?: RetrievedContext[];
  /** Model id the provider reported, for prompt targets. */
  model?: string;
  usage?: Partial<Usage>;
  latency_ms: number;
}

/** The thing under test: a prompt run through a model, or your own pipeline. */
export interface Target {
  kind: 'prompt' | 'command';
  /** Fingerprint of what this target is (prompt text, model, parameters, command). */
  configHash: string;
  /** Model id as configured, for prompt targets. */
  targetModel?: string;
  run(request: TargetRequest): Promise<TargetResponse>;
  close(): Promise<void>;
}

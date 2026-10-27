import type { DatasetRow } from '../dataset';

/** Extra context the mock provider uses to behave like a model. Real providers ignore it. */
export interface ProviderMeta {
  role: 'target' | 'judge';
  row: DatasetRow;
  trial: number;
  /** The output being judged, for role "judge". */
  candidate?: string;
}

export interface CompletionRequest {
  system?: string;
  /** A single user message. */
  prompt: string;
  meta?: ProviderMeta;
}

export interface Completion {
  text: string;
  /** The model id the provider reports back, which can differ from the one configured. */
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  latency_ms: number;
}

export interface Provider {
  readonly id: string;
  complete(request: CompletionRequest): Promise<Completion>;
}

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { CommandTargetConfig } from '../config/types';
import type { RetrievedContext } from '../metrics/types';
import type { Usage } from '../types';
import { shortHash } from '../util/hash';
import { errorMessage } from '../util/text';
import type { Target, TargetResponse } from './types';

const STDERR_TAIL = 4000;

interface Reply {
  id?: unknown;
  output?: unknown;
  contexts?: unknown;
  usage?: unknown;
  model?: unknown;
  error?: unknown;
}

interface Pending {
  id: string;
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Spec {
  command: string | string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

/** One long-lived child process that answers one request at a time over JSON lines. */
class Worker {
  private proc?: ChildProcessWithoutNullStreams;
  private pending?: Pending;
  private stderrTail = '';

  constructor(private readonly spec: Spec) {}

  private start(): ChildProcessWithoutNullStreams {
    const { command, cwd, env } = this.spec;
    const options = { cwd, env: { ...process.env, ...env, ERRORBAR: '1' } };
    const proc =
      typeof command === 'string'
        ? spawn(command, { ...options, shell: true })
        : spawn(command[0] as string, command.slice(1), options);

    createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    proc.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL);
    });
    proc.stdin.on('error', (error) => this.fail(error));
    proc.on('error', (error) => {
      if (this.proc === proc) this.proc = undefined;
      this.fail(error);
    });
    proc.on('close', (code, signal) => {
      if (this.proc === proc) this.proc = undefined;
      this.fail(new Error(`the command exited (${signal ?? `code ${code}`})`), proc);
    });
    this.proc = proc;
    return proc;
  }

  private onLine(line: string): void {
    const text = line.trim();
    if (!text || !this.pending) return;
    let reply: Reply;
    try {
      reply = JSON.parse(text) as Reply;
    } catch {
      return; // stray output from a library; only JSON lines carrying our id count
    }
    if (reply.id !== this.pending.id) return;
    const { resolve, timer } = this.pending;
    clearTimeout(timer);
    this.pending = undefined;
    resolve(reply);
  }

  private fail(error: Error, from?: ChildProcessWithoutNullStreams): void {
    if (from && this.proc && from !== this.proc) return;
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = undefined;
    const tail = this.stderrTail.trim();
    pending.reject(new Error(tail ? `${error.message}. stderr: ${tail}` : error.message));
  }

  request(payload: Record<string, unknown>): Promise<Reply> {
    const proc = this.proc ?? this.start();
    const id = randomUUID();
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        this.kill();
        reject(new Error(`the command did not answer within ${this.spec.timeoutMs} ms`));
      }, this.spec.timeoutMs);
      this.pending = { id, resolve, reject, timer };
      proc.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  }

  kill(): void {
    const proc = this.proc;
    this.proc = undefined;
    proc?.kill();
  }
}

function asContexts(value: unknown): RetrievedContext[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('`contexts` must be an array');
  return value.map((item, i) => {
    const entry = item as { id?: unknown; text?: unknown } | null;
    if (!entry || typeof entry.id !== 'string') {
      throw new Error(`contexts[${i}] needs a string \`id\``);
    }
    return { id: entry.id, text: typeof entry.text === 'string' ? entry.text : '' };
  });
}

function asUsage(value: unknown): Partial<Usage> {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const num = (key: string) => (typeof raw[key] === 'number' ? (raw[key] as number) : undefined);
  return {
    calls: num('calls'),
    input_tokens: num('input_tokens'),
    output_tokens: num('output_tokens'),
  };
}

export interface CommandTargetInput {
  config: CommandTargetConfig;
  /** Absolute working directory. */
  cwd: string;
}

/**
 * Runs your own pipeline. It is started once per worker and kept alive, so an index or a model
 * is loaded once, not once per case. Per request, errorbar writes one line to stdin:
 *   {"id": "...", "case_id": "refund-1", "vars": {...}, "trial": 0}
 * and reads one line from stdout:
 *   {"id": "...", "output": "...", "contexts": [{"id": "doc3", "text": "..."}], "usage": {...}}
 * Anything else on stdout is ignored; log to stderr.
 */
export function createCommandTarget(input: CommandTargetInput): Target {
  const { config } = input;
  const spec: Spec = {
    command: config.command,
    cwd: input.cwd,
    env: config.env ?? {},
    timeoutMs: config.timeout_ms ?? 120_000,
  };
  const workers = Array.from({ length: config.workers ?? 1 }, () => new Worker(spec));
  const idle = [...workers];
  const waiting: Array<(worker: Worker) => void> = [];

  const acquire = (): Promise<Worker> => {
    const free = idle.pop();
    if (free) return Promise.resolve(free);
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = (worker: Worker): void => {
    const next = waiting.shift();
    if (next) next(worker);
    else idle.push(worker);
  };

  return {
    kind: 'command',
    configHash: shortHash({ kind: 'command', command: config.command, env: config.env }),
    async run({ row, trial }): Promise<TargetResponse> {
      const worker = await acquire();
      const started = performance.now();
      try {
        const reply = await worker.request({ case_id: row.id, vars: row.vars, trial });
        if (typeof reply.error === 'string')
          throw new Error(`the command reported: ${reply.error}`);
        if (typeof reply.output !== 'string') {
          throw new Error('the command reply has no string `output`');
        }
        const latency = performance.now() - started;
        const usage = asUsage(reply.usage);
        return {
          output: reply.output,
          contexts: asContexts(reply.contexts),
          model: typeof reply.model === 'string' ? reply.model : undefined,
          usage: { ...usage, latency_ms: latency },
          latency_ms: latency,
        };
      } catch (error) {
        throw new Error(errorMessage(error));
      } finally {
        release(worker);
      }
    },
    async close() {
      for (const worker of workers) worker.kill();
    },
  };
}

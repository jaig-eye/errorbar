import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCommandTarget } from '../src/targets/command';
import type { Target } from '../src/targets/types';

const fixture = path.resolve(__dirname, 'fixtures', 'target.mjs');

function make(workers = 1, timeout_ms = 5000): Target {
  return createCommandTarget({
    config: { type: 'command', command: ['node', fixture], workers, timeout_ms },
    cwd: __dirname,
  });
}

const ask = (target: Target, q: string, id = q) =>
  target.run({ row: { id, vars: { q } }, trial: 0 });

describe('command target', () => {
  it('sends the case and reads output, contexts and usage', async () => {
    const target = make();
    try {
      const out = await ask(target, 'hello');
      expect(out.output).toBe('HELLO');
      expect(out.contexts).toEqual([
        { id: 'a', text: 'Document A' },
        { id: 'b', text: 'Document B' },
      ]);
      expect(out.usage).toMatchObject({ input_tokens: 5, output_tokens: 2 });
      expect(out.model).toBe('fixture-1');
    } finally {
      await target.close();
    }
  });

  it('keeps one process per worker alive and spreads concurrent requests', async () => {
    const target = make(2);
    try {
      const outputs = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((q) => ask(target, q)));
      expect(outputs.map((o) => o.output)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    } finally {
      await target.close();
    }
  });

  it('reports an error the command sends back', async () => {
    const target = make();
    try {
      await expect(ask(target, 'fail')).rejects.toThrow('the command reported: boom');
      expect((await ask(target, 'fine')).output).toBe('FINE');
    } finally {
      await target.close();
    }
  });

  it('survives the command crashing: the request fails, the next one starts a new process', async () => {
    const target = make();
    try {
      await expect(ask(target, 'crash')).rejects.toThrow(/exited \(code 3\)/);
      expect((await ask(target, 'again')).output).toBe('AGAIN');
    } finally {
      await target.close();
    }
  });

  it('gives up on a command that never answers, then recovers', async () => {
    const target = make(1, 400);
    try {
      await expect(ask(target, 'hang')).rejects.toThrow('did not answer within 400 ms');
      expect((await ask(target, 'back')).output).toBe('BACK');
    } finally {
      await target.close();
    }
  });

  it('includes what the command wrote to stderr when it dies', async () => {
    const target = createCommandTarget({
      config: {
        type: 'command',
        command: ['node', '-e', "console.error('model file missing'); process.exit(1)"],
        timeout_ms: 5000,
      },
      cwd: __dirname,
    });
    try {
      await expect(ask(target, 'x')).rejects.toThrow('model file missing');
    } finally {
      await target.close();
    }
  });

  it('runs a string command through the shell', async () => {
    const target = createCommandTarget({
      config: { type: 'command', command: `node "${fixture}"`, timeout_ms: 5000 },
      cwd: __dirname,
    });
    try {
      expect((await ask(target, 'shell')).output).toBe('SHELL');
    } finally {
      await target.close();
    }
  });
});

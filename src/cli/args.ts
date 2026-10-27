import { ConfigError } from '../errors';

export interface FlagSpec {
  /** Flags that take a value: --config file.yaml or --config=file.yaml. */
  values: readonly string[];
  /** Flags that stand alone: --quiet. */
  switches: readonly string[];
}

export interface ParsedArgs {
  positionals: string[];
  values: Map<string, string>;
  switches: Set<string>;
}

export function parseArgs(argv: readonly string[], spec: FlagSpec): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], values: new Map(), switches: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      parsed.positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (spec.switches.includes(name)) {
      parsed.switches.add(name);
    } else if (spec.values.includes(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) throw new ConfigError(`--${name} needs a value`);
      parsed.values.set(name, value);
    } else {
      throw new ConfigError(`Unknown option --${name}`);
    }
  }
  return parsed;
}

export function numberOption(parsed: ParsedArgs, name: string): number | undefined {
  const raw = parsed.values.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ConfigError(`--${name} must be a number, got "${raw}"`);
  return value;
}

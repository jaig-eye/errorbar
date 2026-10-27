import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv, type ErrorObject } from 'ajv';
import { parse as parseYaml } from 'yaml';
import schema from '../../schema/errorbar.schema.json';
import { ConfigError } from '../errors';
import { errorMessage } from '../util/text';
import { isJudgeMetric, judgeProvider, targetProvider } from './resolve';
import type { Config, LoadedConfig, MetricConfig, SuiteConfig } from './types';

const ajv = new Ajv({ allErrors: true, strict: true, strictTypes: false, allowUnionTypes: true });
const validateShape = ajv.compile(schema);

function describeError(error: ErrorObject): string {
  const where = error.instancePath || '(top level)';
  if (error.keyword === 'additionalProperties') {
    return `${where}: unknown option \`${String(error.params.additionalProperty)}\``;
  }
  if (error.keyword === 'enum') {
    return `${where}: ${error.message} (${(error.params.allowedValues as unknown[]).join(', ')})`;
  }
  return `${where}: ${error.message}`;
}

function shapeErrors(errors: ErrorObject[] | null | undefined): string[] {
  const relevant = (errors ?? []).filter((e) => e.keyword !== 'if');
  return [...new Set(relevant.map(describeError))];
}

/** Name a metric will carry in results and reports. */
export function metricName(metric: MetricConfig): string {
  if (metric.name) return metric.name;
  if (metric.type === 'recall_at_k') return `recall@${metric.k}`;
  if (metric.type === 'mrr' && metric.k) return `mrr@${metric.k}`;
  return metric.type;
}

function checkSuite(suite: SuiteConfig, config: Config): string[] {
  const problems: string[] = [];
  const at = `suite "${suite.name}"`;
  const imported = suite.results !== undefined;

  if (imported) {
    if (suite.dataset || suite.target)
      problems.push(`${at}: \`results\` replaces \`dataset\` and \`target\`; remove them`);
    if (suite.metrics)
      problems.push(
        `${at}: with \`results\`, every metric in the file is gated; remove \`metrics\``,
      );
    return problems;
  }

  if (!suite.dataset) problems.push(`${at}: needs a \`dataset\` (or \`results\` to import scores)`);
  if (!suite.target) problems.push(`${at}: needs a \`target\` (or \`results\` to import scores)`);
  if (!suite.metrics || suite.metrics.length === 0)
    problems.push(`${at}: needs at least one metric`);

  const provider = targetProvider(suite, config);
  if (suite.target?.type === 'prompt') {
    if (!provider)
      problems.push(`${at}: the prompt target needs a \`provider\` (or set \`defaults.provider\`)`);
    else if (provider.type !== 'mock' && !provider.model) {
      problems.push(`${at}: the provider needs a \`model\``);
    }
  }

  const seen = new Set<string>();
  for (const metric of suite.metrics ?? []) {
    const name = metricName(metric);
    if (seen.has(name))
      problems.push(`${at}: two metrics are called "${name}"; give one a \`name\``);
    seen.add(name);

    const needsCommand =
      metric.type === 'recall_at_k' || metric.type === 'mrr' || metric.type === 'faithfulness';
    if (needsCommand && suite.target?.type !== 'command') {
      problems.push(
        `${at}, metric "${name}": ${metric.type} scores retrieved contexts, which only a \`command\` target returns`,
      );
    }

    if (isJudgeMetric(metric)) {
      const judge = judgeProvider(metric, suite, config);
      if (!judge) {
        problems.push(
          `${at}, metric "${name}": needs a judge; set \`judge\` or \`defaults.judge\``,
        );
      } else if (judge.type !== 'mock' && !judge.model) {
        problems.push(`${at}, metric "${name}": the judge needs a \`model\``);
      }
    }
    if (metric.type === 'regex') {
      try {
        new RegExp(metric.pattern, metric.flags);
      } catch (error) {
        problems.push(`${at}, metric "${name}": bad pattern (${errorMessage(error)})`);
      }
    }
    if (metric.type === 'json_schema') {
      try {
        ajv.compile(metric.schema);
      } catch (error) {
        problems.push(`${at}, metric "${name}": bad schema (${errorMessage(error)})`);
      }
    }
  }
  return problems;
}

/** Checks a parsed config against the schema and the rules a schema cannot express. */
export function validateConfig(raw: unknown): Config {
  if (!validateShape(raw)) {
    throw new ConfigError(
      `Invalid config:\n${shapeErrors(validateShape.errors)
        .map((m) => `  - ${m}`)
        .join('\n')}`,
    );
  }
  const config = raw as unknown as Config;

  const problems: string[] = [];
  const names = new Set<string>();
  for (const suite of config.suites) {
    if (names.has(suite.name)) problems.push(`two suites are called "${suite.name}"`);
    names.add(suite.name);
    problems.push(...checkSuite(suite, config));
  }
  for (const pattern of config.redact ?? []) {
    try {
      new RegExp(pattern);
    } catch (error) {
      problems.push(`redact: bad pattern ${JSON.stringify(pattern)} (${errorMessage(error)})`);
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(`Invalid config:\n${problems.map((m) => `  - ${m}`).join('\n')}`);
  }
  return config;
}

export function parseConfig(text: string, source = 'config'): Config {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`Could not parse ${source}: ${errorMessage(error)}`);
  }
  return validateConfig(raw);
}

export function loadConfig(configPath: string): LoadedConfig {
  const absolute = path.resolve(configPath);
  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new ConfigError(`Could not read config ${absolute}: ${errorMessage(error)}`);
  }
  return { config: parseConfig(text, absolute), path: absolute, dir: path.dirname(absolute) };
}

/** Resolves a path from the config against the config file's directory. */
export function resolveFrom(loaded: Pick<LoadedConfig, 'dir'>, relative: string): string {
  return path.resolve(loaded.dir, relative);
}

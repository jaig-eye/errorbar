/** A problem with the user's setup: a bad config, a missing file, a missing key. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** A provider API key is not set. The Action turns this into a skip on fork pull requests. */
export class MissingSecretError extends ConfigError {
  readonly variables: string[];
  constructor(variables: string[]) {
    super(
      `Missing API key: set ${variables.map((v) => `\`${v}\``).join(', ')} in the environment of the job.`,
    );
    this.name = 'MissingSecretError';
    this.variables = variables;
  }
}

/** A model API answered with an error that retrying will not fix, or kept failing. */
export class ProviderError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

/** The run made more provider calls than `max_calls` allows. */
export class BudgetExceededError extends Error {
  constructor(max: number) {
    super(`Stopped: the run reached max_calls (${max}) provider calls.`);
    this.name = 'BudgetExceededError';
  }
}

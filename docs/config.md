# Configuration reference

errorbar reads one YAML file, `errorbar.yaml` by default. Paths inside it are relative to the
file. It is validated against [`schema/errorbar.schema.json`](../schema/errorbar.schema.json);
an unknown option is an error, so a typo cannot silently turn something off. For editor
autocompletion add this as the first line:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/jaig-eye/errorbar/main/schema/errorbar.schema.json
```

## Top level

| Key | | |
|---|---|---|
| `version` | required | Always `1`. |
| `defaults` | | `trials`, `concurrency`, `provider`, `judge`. Used by suites that do not set their own. |
| `gate` | | When a change fails the build. See [gate](#gate). |
| `redact` | | List of regular expressions. Matches are replaced with `[redacted]` in stored outputs. |
| `max_calls` | | Safety cap on provider calls in one run. The run aborts when it is reached. |
| `suites` | required | One or more suites. |

## gate

| Key | Default | |
|---|---|---|
| `max_drop` | `0.03` | Largest acceptable drop on the 0-1 score scale. A metric can override it. |
| `confidence` | `0.95` | Two-sided confidence level of each metric's interval. |
| `on_inconclusive` | `warn` | `warn`, `fail` or `pass`: what a metric that cannot be called either way does to the build. |
| `min_cases` | `10` | Fewer paired cases than this is never a verdict. |
| `bootstrap` | `10000` | Bootstrap resamples. |
| `seed` | `errorbar` | Makes verdicts repeatable. Also seeds the mock provider. |
| `max_error_rate` | `0.1` | Share of errored trials allowed before the run counts as broken. |
| `flaky_threshold` | `0.5` | A case is flaky when its trials differ by at least this on a metric. |

## Suites

```yaml
suites:
  - name: support-bot          # letters, digits, space and _ . @ : / + -
    dataset: evals/cases.jsonl # one case per line
    trials: 3                  # default: defaults.trials, then 3
    concurrency: 4
    target: { ... }            # what is under test
    metrics: [ ... ]           # what to score
```

A suite either runs a `target` over a `dataset`, or imports scores with `results`
([import](#importing-scores)). Not both.

### Dataset

JSON Lines. Fields:

| Field | |
|---|---|
| `id` | **Required.** Cases are paired across runs by id, so keep ids stable and unique. |
| `vars` | Values for the prompt's `{{placeholders}}`, or for your command. |
| `expected` | The reference answer, for `equals`, `contains` and judge rubrics. Never sent to your command. |
| `relevant_ids` | Ids of the documents that should be retrieved, for `recall_at_k` and `mrr`. |
| `tags`, `notes` | For you. |

Any other field is an error. A case whose row changes between runs is treated as edited and
left out of the comparison.

### Targets

**`prompt`** fills a template and calls a model.

```yaml
target:
  type: prompt
  prompt: prompts/answer.md     # {{name}} or {{a.b}} is replaced from the case's vars
  system: prompts/system.md     # optional; same placeholders
  provider: { ... }             # optional; defaults.provider otherwise
```

Every placeholder must be satisfied by every case, or the run stops before spending anything.

**`command`** runs your own pipeline.

```yaml
target:
  type: command
  command: [python3, rag.py]    # or a string, run through the shell
  workers: 2                    # processes started
  timeout_ms: 120000            # per request
  cwd: .                        # relative to the config file
  env: { MY_FLAG: "1" }
```

The command is started once per worker and kept running. For each request errorbar writes one
line to its stdin:

```json
{"id": "0b1f...", "case_id": "refund-3", "vars": {"question": "..."}, "trial": 0}
```

and reads one line from its stdout:

```json
{"id": "0b1f...", "output": "...", "contexts": [{"id": "doc3", "text": "..."}], "usage": {"input_tokens": 120, "output_tokens": 40}, "model": "my-model-1"}
```

`id` must be echoed. `contexts` (in rank order) is needed for retrieval metrics and
`faithfulness`. `{"id": "...", "error": "message"}` records a failure for that trial. Lines
that are not JSON carrying the request id are ignored, but write logs to **stderr**: if the
command dies, its last 4 KB of stderr is included in the error. A command that crashes or times
out is restarted for the next request.

The command runs with your job's environment. Treat it like any code that runs in CI; see
[security](security.md).

### Providers

```yaml
provider:
  type: anthropic              # anthropic | openai | mock
  model: claude-haiku-5-5
  temperature: 0.2             # optional; null leaves it out of the request
  max_tokens: 400
  api_key_env: MY_KEY_VAR      # default ANTHROPIC_API_KEY / OPENAI_API_KEY
  base_url: https://...        # override the API base
  timeout_ms: 120000
  max_retries: 4               # 429, 5xx and network errors, with backoff and Retry-After
```

`openai` speaks Chat Completions, so it covers OpenAI and anything compatible: Azure, Groq,
OpenRouter, Ollama, vLLM, Gemini's OpenAI-compatible endpoint. Set `base_url`. A server with a
custom `base_url` and no `api_key_env` needs no key. `max_tokens_param` picks `max_tokens` or
`max_completion_tokens` (OpenAI's own API wants the latter, most others the former, and that is
the default for each).

`mock` is a stand-in for a model, for trying errorbar and testing your workflow. As a target it
answers with the case's `expected` text with probability `accuracy`; a line like
`mock-accuracy: 0.6` anywhere in the prompt overrides it. As a judge it scores by whether the
answer contains the expected text.

### Metrics

Every metric takes `name` (defaults to the type), `gate` (`false` to report it without letting
it fail the build) and `max_drop` (override for this metric). A score is always between 0 and 1.

| Type | Options | Scores 1 when |
|---|---|---|
| `equals` | `value`, `ignore_case`, `trim` | The output equals `value` (default: the case's `expected`). Trims by default. |
| `contains` | `value`, `ignore_case` | The output contains `value` (default `expected`). |
| `not_contains` | `value`, `ignore_case` | It does not. |
| `regex` | `pattern`, `flags` (`i`, `m`, `s`, `u`) | The pattern matches. |
| `json_valid` | | The output parses as JSON (a Markdown fence around it is accepted). |
| `json_schema` | `schema` | It parses and satisfies the JSON Schema. |
| `max_length` | `max`, `unit` (`chars`, `words`) | The output is no longer than `max`. |
| `recall_at_k` | `k` | Share of the case's `relevant_ids` in the top `k` contexts. Command targets only. |
| `mrr` | `k` | 1 / rank of the first relevant context, else 0. Command targets only. |
| `rubric` | `rubric`, `scale`, `judge` | A judge scores 1 to `scale` (default 5) against your rubric. Mapped to 0-1. |
| `faithfulness` | `scale`, `judge` | A judge checks the answer is supported by the retrieved contexts. Command targets only. |
| `answer_relevance` | `scale`, `judge` | A judge checks the answer addresses the question. |

A case without what a metric needs (no `expected`, no `relevant_ids`) is **not applicable** for
that metric and is skipped for it, not counted as a failure.

**Judges.** The judge is `metric.judge`, else `defaults.judge`, else the target's provider,
else `defaults.provider`. It runs at temperature 0 unless you set one (set `temperature: null` on the judge if a model rejects the parameter), sees the case's inputs,
the reference, the retrieved contexts and the answer, and must reply with JSON. The answer is
placed between unguessable delimiters and marked as data, so text inside it cannot pose as an
instruction (this reduces, and cannot eliminate, prompt injection through the answer). If the
reply cannot be read, the judge is asked once more; after that the trial is recorded as errored.

## Importing scores

```yaml
suites:
  - { name: external, results: scores.jsonl }
```

One JSON object per line:

| Field | |
|---|---|
| `case_id` | Required. |
| `metric` | Required. Every metric found in the file is gated. |
| `score` | Required, 0 to 1. Rescale first if your tool uses another range. |
| `trial` | Optional non-negative integer. Default 0. |
| `input_hash` | Optional. Change it when a case's question or reference changes; edited cases are then left out of the comparison. |
| `input`, `output` | Optional, shown in reports. |

## Environment

| Variable | |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Default provider keys. Override per provider with `api_key_env`. |
| `ERRORBAR_SIMS` | Number of simulated runs in the calibration tests (default 2000). Not used outside tests. |

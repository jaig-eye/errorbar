# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/). The results file has its own
`schema` number; a baseline written by a different schema is rejected with a clear message.

## [0.1.0] - 2026-10-26

First release.

### Added

- **GitHub Action** that runs eval suites on a pull request, finds the baseline from the base
  branch (the results artifact of the latest successful non-pull-request run), compares, posts
  one updating pull request comment, writes the job summary, and fails the check on a
  regression. Skips cleanly on fork pull requests that have no secrets.
- **Statistical gate**: paired comparison on the same cases, a case-level bootstrap confidence
  interval, a non-inferiority rule against `max_drop`, Holm correction across gated metrics, a
  power readout (minimum detectable drop and cases needed), and an *inconclusive* verdict for
  suites too small or noisy to call.
- **Targets**: `prompt` (template plus provider) and `command` (your own pipeline over JSON
  lines, kept running between cases).
- **Providers**: Anthropic, any OpenAI-compatible endpoint, and a seeded `mock` provider.
  Retries with backoff and `Retry-After`, timeouts, and a `max_calls` cap.
- **Metrics**: `equals`, `contains`, `not_contains`, `regex`, `json_valid`, `json_schema`,
  `max_length`, `recall_at_k`, `mrr`, and LLM-judge `rubric`, `faithfulness` and
  `answer_relevance`.
- **Import** of scores from other tools as JSON lines, gated the same way.
- **CLI**: `run`, `compare`, `import`, `init`.
- Detection of edited, added and removed cases, changed metric definitions, model alias moves,
  flaky cases, and runs broken by errored trials.
- A JSON Schema for the config, calibration simulations for the statistics, and two runnable
  examples (a prompt suite and a Python RAG pipeline).

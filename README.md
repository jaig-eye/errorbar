# errorbar

**An LLM eval regression gate for pull requests. It fails the build only when quality drops by more than the noise can explain.**

[![ci](https://github.com/jaig-eye/errorbar/actions/workflows/ci.yml/badge.svg)](https://github.com/jaig-eye/errorbar/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

errorbar runs your prompt or RAG eval suite on every pull request, compares it with the same
suite on your main branch, and posts what changed. It does not ask "is the average above 0.80?"
That question flakes: LLM outputs are noisy, so a fixed threshold either fails at random until
people stop trusting it, or sits low enough to let real regressions through.

Instead it asks "did quality drop by more than run-to-run noise explains?", and it tells you how
big a drop your suite is able to detect at all.

```text
errorbar ❌ regression in support-bot › helpfulness

| metric       | base  | head  | Δ (95% CI)              | verdict         |
|--------------|------:|------:|------------------------:|-----------------|
| helpfulness  | 0.745 | 0.649 | -0.096 [-0.101, -0.091] | ❌ regression   |
| has_citation | 0.960 | 0.960 |  0.000 [ 0.000,  0.000] | ✓ no change     |
| recall@5     | 0.873 | 0.873 |  0.000 [ 0.000,  0.000] | ✓ no change     |

59 paired cases × 3 trials · detects drops ≥ 0.01 at 80% power · 7 flaky cases · baseline main@abcdef0
▸ Biggest drops (input, before, after)   ▸ Flaky cases   ▸ Dataset changes
```

- **No account, no SaaS.** It runs in your workflow with your own model keys. Anthropic, any OpenAI-compatible endpoint (OpenAI, Azure, Groq, OpenRouter, Ollama, vLLM) and your own pipeline in any language.
- **Honest about noise.** Several trials per case, a confidence interval around every change, and a verdict of *inconclusive* when the suite is too small to tell. That is never reported as a pass.
- **Prompts and RAG.** Exact-match and regex checks, JSON validity, retrieval metrics (recall@k, MRR) and LLM-judge rubrics, including faithfulness and answer relevance.
- **Built to be checked.** The false-alarm rate and the power are tested by simulation in [`test/calibration.test.ts`](test/calibration.test.ts), and the method is written down in [docs/methodology.md](docs/methodology.md).

## Quick start

1. **Scaffold a project** (a config, a small dataset, a prompt and a workflow):

   ```bash
   npx github:jaig-eye/errorbar init
   ```

   Add `--mock` to get a version that runs with no API key.

2. **Add your key** as a repository secret, for example `ANTHROPIC_API_KEY`.

3. **Commit it and push to `main`.** That first run becomes the baseline.

4. **Open a pull request that changes a prompt.** errorbar runs the suite, finds the baseline from `main`, and comments with the result. A regression fails the check.

The workflow it writes:

```yaml
name: evals
on:
  pull_request:
  push:
    branches: [main]   # every run on main becomes the baseline pull requests are compared with
permissions:
  contents: read
  actions: read          # find the baseline from main
  pull-requests: write   # post the report
jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: jaig-eye/errorbar@v0   # pin a full commit SHA in production
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Try it without any setup: [`examples/support-bot`](examples/support-bot) (a prompt) and
[`examples/rag-python`](examples/rag-python) (a RAG pipeline) both run offline.

```bash
npx github:jaig-eye/errorbar run --config examples/support-bot/errorbar.yaml
```

## How a verdict is decided

For each metric, errorbar averages each case's trials, takes the difference between the pull
request and the baseline *on the same cases*, and builds a 95% confidence interval around the
mean difference by resampling **cases** (not trials, which would make the interval too narrow).

| Verdict | Meaning | Build |
|---|---|---|
| ❌ **regression** | A drop that is statistically real and at least `max_drop` (default 0.03). | fails |
| ⚠️ **inconclusive** | The interval is too wide to rule out a drop of `max_drop`. The suite is too small or too noisy to say. | warns (configurable) |
| ✓ **pass** | The interval rules out any drop bigger than `max_drop`. | passes |
| 🟢 **improved** | The whole interval is above zero. | passes |

Testing several metrics together raises the bar (Holm correction), so gating five metrics does
not make a false alarm five times as likely. Cases you added, removed or edited in the same
pull request are listed but not compared, since they are not the same question on both sides.
If the model alias moved underneath you (`claude-x` now resolves to a new snapshot), a
regression is reported as inconclusive with the reason, rather than blamed on your change.

The details, and the simulations behind the numbers, are in [docs/methodology.md](docs/methodology.md).

## Configuration

```yaml
# errorbar.yaml
version: 1

defaults:
  trials: 3
  provider: { type: anthropic, model: claude-haiku-5-5, max_tokens: 400 }

gate:
  max_drop: 0.03          # largest acceptable drop on the 0-1 score scale
  on_inconclusive: warn   # warn | fail | pass

suites:
  - name: support-bot
    dataset: evals/support.jsonl          # one case per line: {"id", "vars", "expected"}
    target:
      type: prompt
      system: prompts/system.md
      prompt: prompts/answer.md           # {{question}} is filled from each case's vars
    metrics:
      - { type: contains, name: states_the_policy }      # the case's `expected` is in the answer
      - { type: regex, name: cites_source, pattern: "\\[\\d+\\]" }
      - type: rubric                                     # an LLM judge scores 1-5
        name: helpfulness
        rubric: The answer is correct, direct, and adds nothing that was not asked.
```

Editors that understand JSON Schema can autocomplete this file:
`# yaml-language-server: $schema=https://raw.githubusercontent.com/jaig-eye/errorbar/main/schema/errorbar.schema.json`.
Every option is in [docs/config.md](docs/config.md).

### Test a RAG pipeline

Point errorbar at the pipeline you already have, in any language. It is started once and kept
running; errorbar writes one JSON line per request to its stdin and reads one back from stdout.

```yaml
suites:
  - name: help-center
    dataset: evals/rag.jsonl     # {"id", "vars": {"question"}, "expected", "relevant_ids": [...]}
    trials: 1                    # a pipeline that never varies needs only one
    target: { type: command, command: [python3, rag.py], workers: 2 }
    metrics:
      - { type: recall_at_k, k: 5 }
      - { type: mrr }
      - { type: contains, name: answer_has_fact }
      - { type: faithfulness }     # a judge checks the answer against the retrieved text
```

```python
# rag.py
import json, sys
for line in sys.stdin:
    request = json.loads(line)                      # {"id", "case_id", "vars", "trial"}
    answer, docs = my_pipeline(request["vars"]["question"])
    print(json.dumps({
        "id": request["id"],                        # always echo the id
        "output": answer,
        "contexts": [{"id": d.id, "text": d.text} for d in docs],   # in rank order
    }), flush=True)
```

A complete, dependency-free version is in [`examples/rag-python`](examples/rag-python).

### Gate results from another tool

Already scoring with another framework? Feed its scores in as JSON lines and get the same
paired comparison, confidence intervals and report:

```yaml
suites:
  - { name: external, results: scores.jsonl }
```

```json
{"case_id": "refund-3", "trial": 0, "metric": "accuracy", "score": 1, "input_hash": "9f2c1a"}
```

Give `input_hash` a value that changes when a case's question or reference changes, so edited
cases are left out of the comparison instead of counted as a regression.

## The Action

```yaml
- uses: jaig-eye/errorbar@v0
  with:
    config: errorbar.yaml
```

| Input | Default | |
|---|---|---|
| `config` | `errorbar.yaml` | Path to the config. |
| `working-directory` | `.` | Where `config` is resolved from. |
| `suite` | all | Run only this suite. |
| `baseline` | `artifact` | `artifact` (latest successful run on the base branch), `file` (`baseline-path`), or `none`. |
| `baseline-branch` | PR base | Branch the baseline comes from. |
| `artifact-name` | `errorbar-results` | Name of the results artifact. |
| `artifact-retention-days` | `30` | Baselines older than this are gone. |
| `comment` | `true` | Post and update one pull request comment. |
| `comment-tag` | | Keeps two errorbar jobs on one pull request from sharing a comment. |
| `on-missing-secrets` | `auto` | `auto` skips on fork pull requests and fails elsewhere. |
| `github-token` | `github.token` | |

Outputs: `verdict` (`pass`, `warn`, `fail`, `error`, `no_baseline`, `recorded`, `skipped`),
`results-path`, `report-path`. The report is also written to the job summary.

## The CLI

```bash
npx github:jaig-eye/errorbar run --config errorbar.yaml        # run the suites, write .errorbar/results.json
npx github:jaig-eye/errorbar run --baseline base.json          # ...and compare, exit 1 on a regression
npx github:jaig-eye/errorbar compare base.json head.json       # compare two results files
npx github:jaig-eye/errorbar import scores.jsonl --suite name  # turn another tool's scores into a results file
npx github:jaig-eye/errorbar init                              # scaffold a project
```

Exit codes: `0` no regression, `1` regression, `2` the run itself was broken (bad config,
missing key, too many errored trials). A broken run is never reported as a verdict.

## How it compares

As of October 2026, from each project's public documentation. Corrections are welcome.

| | Gate | Baseline from your main branch | Needs a vendor account |
|---|---|---|---|
| **errorbar** | Statistical comparison with a confidence interval, plus a power readout | Yes, by default | No |
| promptfoo (`promptfoo-action`) | Fixed pass-rate threshold; repeats counted k-of-n | No: it evaluates the current checkout | No |
| DeepEval | Per-metric thresholds in pytest | No | Optional (Confident AI) |
| Braintrust (`eval-action`) | Compares with a baseline experiment | Yes, as a Braintrust experiment | Yes |
| Inspect AI | None built in; error bars within a single run | No | No |

These are good tools and errorbar does not replace them. The point is the gate: they are
mostly built to *run* evals, and errorbar is built to decide whether a change made things
worse. You can keep scoring with them and gate their scores with errorbar through
[the import](#gate-results-from-another-tool).

## Limits

- **It can only see what your dataset covers.** A regression on questions you never wrote down is invisible. Add cases when you find a failure in production.
- **An LLM judge is a measuring instrument with its own error.** errorbar keeps the judge at temperature 0, flags judge model changes, and refuses to compare scores from a changed rubric. It does not yet calibrate the judge against human labels; see the [roadmap](ROADMAP.md).
- **Small suites detect only big drops.** The report prints the smallest drop your suite can reliably catch. If that number is bigger than the drops you care about, add cases.
- **The gate settings come from the pull request.** Someone who can edit `errorbar.yaml` can loosen it. Protect it with CODEOWNERS and required review; see [docs/security.md](docs/security.md).
- **Results are only comparable when the pipeline around the model is stable.** Changing the dataset row is handled; changing a judge or metric definition is detected and not compared.

## Documentation

- [Configuration reference](docs/config.md)
- [Methodology and calibration](docs/methodology.md)
- [Recipes](docs/recipes.md): other providers, a committed baseline, several suites, controlling cost
- [Security](docs/security.md): fork pull requests, secrets, who can change the gate

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). If you change
the statistics, the calibration tests are the thing that has to keep passing.

## Acknowledgements

The method follows the ideas in Evan Miller's [*Adding Error Bars to Evals*](https://arxiv.org/abs/2411.00640)
(2024): treat an eval as an experiment, pair comparisons on the same questions, account for
clustered observations, and plan with power analysis. errorbar uses a case-level bootstrap
where the paper uses analytic standard errors.

## License

[MIT](LICENSE)

# Recipes

## Use another model provider

Anything that speaks the OpenAI Chat Completions API works with `type: openai` and a `base_url`:

```yaml
defaults:
  provider:
    type: openai
    model: llama-3.3-70b
    base_url: https://api.groq.com/openai/v1
    api_key_env: GROQ_API_KEY
```

A local Ollama server needs no key:

```yaml
provider: { type: openai, model: llama3.2, base_url: "http://localhost:11434/v1" }
```

Use a different model as judge than as the system under test; a model grading its own output is
a known source of bias:

```yaml
defaults:
  provider: { type: anthropic, model: claude-haiku-5-5 }
  judge: { type: anthropic, model: claude-sonnet-5-5 }
```

## Pick `max_drop` and the number of cases

Run the suite once and read the footer of the report: *detects drops ≥ X at 80% power*. That X
is what your suite can see. If it is larger than the drop you want to catch, you need more
cases, and the report says roughly how many (*About N cases would settle it*).

Rules of thumb:

- Start with `trials: 3` for anything that samples a model. A pipeline that never varies needs 1.
- More cases help more than more trials. Trials only average out the noise inside a case; they
  do nothing for case-to-case spread.
- `max_drop` is a product decision, not a statistical one: how much worse is too much? 0.03 means
  "three points on a 0-1 scale".

## A committed baseline instead of a CI artifact

Artifacts expire (30 days by default). If you would rather pin a baseline in the repository and
update it on purpose:

```bash
npx github:jaig-eye/errorbar run --out evals/baseline.json
git add evals/baseline.json && git commit -m "chore: update eval baseline"
```

```yaml
- uses: jaig-eye/errorbar@v0
  with:
    baseline: file
    baseline-path: evals/baseline.json
```

Update it in a pull request of its own so the change is reviewed.

## Several suites, or several jobs

Several suites in one config are compared together (and corrected for testing many metrics
together). To run separate jobs for one repository, give each its own artifact and comment:

```yaml
- uses: jaig-eye/errorbar@v0
  with:
    config: evals/rag.yaml
    artifact-name: errorbar-rag
    comment-tag: rag
```

## Report a metric without gating on it

```yaml
metrics:
  - { type: max_length, name: brevity, max: 80, unit: words, gate: false }
```

It appears in the table with its change and interval, and never fails the build.

## A pipeline in TypeScript

```ts
// pipeline.ts, run with: command: [node, pipeline.ts]   (Node 24 runs TypeScript directly)
import { createInterface } from 'node:readline';

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const { answer, documents } = await myPipeline(request.vars.question);
  console.log(JSON.stringify({
    id: request.id,
    output: answer,
    contexts: documents.map((d) => ({ id: d.id, text: d.text })),
  }));
}
```

Start expensive things (an index, a model) before the loop: the process is reused for every
case. Write logs to `console.error`, not `console.log`.

## Emit scores from another tool

Any tool that can write one line per (case, metric, trial) can be gated:

```python
import json

with open("scores.jsonl", "w") as out:
    for case in results:
        for trial, score in enumerate(case.trial_scores):
            out.write(json.dumps({
                "case_id": case.id,
                "trial": trial,
                "metric": "accuracy",
                "score": score,          # 0 to 1
                "input_hash": case.content_hash,
            }) + "\n")
```

```yaml
suites:
  - { name: external, results: scores.jsonl }
```

## Keep the cost down

- Set `max_calls` as a backstop.
- Use `trials: 1` for deterministic parts of a pipeline.
- Run the judge on a smaller model, and only on the metrics that need one.
- Do not add a `paths:` filter to the `push` trigger on `main` unless it covers everything the
  eval depends on, including pipeline code: a skipped run on `main` leaves a stale baseline.
- A response cache is on the [roadmap](../ROADMAP.md).

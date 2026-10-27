# Roadmap

What is planned, roughly in order. Nothing here is a promise; the order follows what makes the
gate more trustworthy first.

## Next

- **Importers** for the result formats of other eval tools (promptfoo first), so
  "add error bars to your existing CI" is one line.
- **Response cache** (`@actions/cache`) so an unchanged case on an unchanged prompt is not paid
  for twice.
- **Budget gates**: fail on a significant increase in tokens, cost or p95 latency against the
  baseline, with the same interval-based verdict as quality.
- **Gate settings from the base branch**, so a pull request cannot loosen its own gate.
- **`baseline: rerun`**: run the base commit in the same job, so base and head share a time
  window and a model snapshot.

## Later

- **Judge calibration** (`errorbar calibrate`): score a labelled set with the judge and report
  agreement with the human labels (Cohen's κ, true/false positive rate), then correct pass rates
  for the judge's error rate before they reach the gate.
- **Pairwise judging** with position swapping, for "is B better than A" instead of absolute
  scores.
- Custom command graders and an `http` target.
- A stable results schema and a v1.0 with the Marketplace listing.

## Feature Proposals

New ideas go here, newest last. Open an issue to discuss before building anything large.

- Report trend over the last N baselines to spot slow drift that no single pull request causes.
- A `--changed-only` mode that re-runs only the cases whose inputs or prompts changed.
- Per-tag breakdown of results (`tags` on cases) in the report.

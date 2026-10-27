# Security

errorbar runs your prompts, your pipeline and your model keys inside CI, on code that a pull
request author controls. This page is what that means and how to keep it safe. To report a
vulnerability in errorbar itself, see [SECURITY.md](../SECURITY.md).

## Use `pull_request`, not `pull_request_target`

`pull_request` runs the pull request's code with a read-only token and **without secrets** for
forks. `pull_request_target` runs with secrets and a write token. Combined with checking out the
pull request's code, it hands your keys to whoever opens a pull request. Do not use it with
errorbar.

## Pull requests from forks

Secrets are not available to workflows triggered by a fork's pull request, so there is no key to
call a model with. By default (`on-missing-secrets: auto`) errorbar notices that the pull request
is from a fork, skips the evals, writes a notice and exits 0. On a same-repository pull request
a missing key is an error, so a misconfigured secret does not look like a pass.

If you want evals on fork pull requests, run them from a trusted workflow after a maintainer
reviews the change, not by loosening the trigger.

## Who can change the gate

The gate's settings (`max_drop`, `on_inconclusive`, which metrics exist, the dataset, the prompt)
live in the pull request. Someone who can edit `errorbar.yaml` can loosen the gate, remove a
metric, or delete the hard cases. That is true of every CI check defined in the repository.

- Put `errorbar.yaml`, the dataset directory and the prompt directory under
  [CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
  and require review from those owners.
- Make the errorbar job a required status check on the base branch.
- Edited and removed dataset cases are listed in the report, so a review can see what changed.

## The baseline is trusted only if it came from your branch

The baseline is the artifact of a successful run of this workflow on the base branch. errorbar
only considers runs of **this repository** that were **not** triggered by a pull request, so a
fork's pull request from a branch that happens to be named `main` cannot supply a baseline.

Anyone who can push to the base branch (or run the workflow there) can produce a baseline;
protect the branch accordingly.

## `command` targets run code

A `command` target runs a program from your repository with the job's environment, including
any secrets exposed to the step. It is exactly as trusted as your test suite. Scope the secrets
you expose to the errorbar step only (set `env:` on that step, not on the job), and use a model
key with a spend limit.

## Cost controls

An eval run costs money, and a pull request can change how much it costs (more cases, more
trials, a bigger model). Set `max_calls` in the config to stop a run at a fixed number of provider
calls, set a spend limit on the API key, and keep the key to this job. errorbar counts
retries as part of one call, not extra ones.

## What is stored and posted

`results.json` holds the model outputs for every case and trial (truncated to 4,000 characters
each), and the job summary and pull request comment show some of them. Treat both like the
dataset itself:

- Artifacts are readable by anyone with read access to the repository. Use a private
  repository for sensitive data.
- Use `redact` to scrub patterns (emails, ids, tokens) from stored outputs and errors.
- API keys are never written to results, logs or comments. Error messages from a provider are
  scrubbed of the key before they are stored.

## Judge prompt injection

When a judge scores a model's answer, that answer is untrusted text. errorbar places it between
delimiters generated fresh for each call and tells the judge to treat the contents as data. This
raises the bar; it does not make a judge immune. Where a rubric result gates a release, prefer
deterministic metrics next to it, and read the biggest movers in the report.

## Supply chain

- Runtime dependencies are pinned to exact versions, each at least seven days old when chosen.
- Dependabot waits seven days before proposing an update.
- Every action in this repository's workflows is pinned to a full commit SHA. Do the same when
  you use errorbar: `uses: jaig-eye/errorbar@<sha>  # v0.1.0`.
- `dist/` is built from source in CI and a check fails if the committed copy differs.
- Release builds are attested with GitHub build provenance. Verify one with
  `gh attestation verify dist/index.js --repo jaig-eye/errorbar`.
- The code is scanned with CodeQL.

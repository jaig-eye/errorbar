# Methodology

How errorbar decides that a pull request made things worse, why it is built that way, and what
the simulations in [`test/calibration.test.ts`](../test/calibration.test.ts) show.

## The problem with a fixed threshold

A gate like "fail if average accuracy is below 0.80" has two failure modes, and both are
common with LLM evals:

- **It flakes.** Outputs vary run to run, and a suite that scores 0.81 on one run scores 0.79
  on the next with no change at all. People re-run until it goes green, then stop looking.
- **It misses.** Set the threshold low enough to stop flaking and it also lets through a real
  drop from 0.95 to 0.83.

The question that matters is relative and statistical: *is the score on this branch lower than
on main by more than the noise can explain?*

## What gets compared

1. **Trials.** Each case runs `trials` times (default 3). A case's score for a metric is the
   mean of its trials. Trials of one case move together, which is why the next step matters.
2. **Pairing.** The pull request and the baseline are compared **on the same cases**. For
   case *i*, the change is `d_i = head_i − base_i`. Pairing removes the variation between easy
   and hard cases, which is usually the biggest source of spread in a score.
3. **Cases that are not the same question** are left out and listed: cases only in the pull
   request (added), only in the baseline (removed), or whose dataset row changed (edited, by a
   content hash of the row).
4. **Metrics that are not the same instrument** are left out and listed: a metric whose
   definition changed (pattern, rubric, scale, judge model) has a different `config_hash` in
   the baseline and is not compared.

## The interval: resample cases, not trials

The 95% confidence interval for the mean change comes from a percentile bootstrap over the
`d_i` values, 10,000 resamples, seeded so the same inputs always give the same verdict.

The unit being resampled is the **case**. Treating every trial as an independent observation
looks like more data, but trials of one case are correlated, so it makes the interval too
narrow and the gate trigger-happy. When a change helps some cases and hurts others, the
calibration test shows the gap:

| Method (50 cases, 5 trials, no true average change) | False-alarm rate |
|---|---:|
| Resample cases (errorbar) | 2.85% |
| Treat every trial as independent | 11.9% |

(Nominal is 2.5% one-sided. 8,000 simulated runs each.)

A plain bootstrap of a mean is a little too narrow at small sample sizes, because the variance
of the resampled mean is `(n − 1)/n` times the real one. errorbar widens the resampled
deviations by `√(n/(n − 1))` (Hesterberg's bootstrap expansion). The remaining excess at very
small *n* is the gap between a normal and a *t* distribution.

## The decision

Let `δ = max_drop` (default 0.03), α = 1 − confidence (default 0.05), and let `p` be the
bootstrap one-sided p-value for "the true change is below zero", after Holm correction across
every gated metric in the run.

| Verdict | Condition |
|---|---|
| regression | `p < α/2` **and** mean change ≤ −δ |
| improved | the interval's lower end > 0 |
| pass | the interval's lower end ≥ −δ |
| inconclusive | none of the above, or fewer paired cases than `min_cases` (default 10) |

A **regression** must be both *real* (statistically) and *big enough to matter* (≥ δ).
Without the second condition a very large suite fails the build for a drop of 0.002.

A **pass** is a positive claim: the interval rules out any drop bigger than δ. It is not
"we did not find a regression". If the data cannot support that claim the verdict is
**inconclusive**, which warns by default and can be set to fail (`on_inconclusive`).

### Several metrics at once

Gate five metrics at the 2.5% level and the chance that at least one fires by luck is about
12%. errorbar applies the Holm step-down correction to the regression p-values of all gated
metrics in a run, which controls that family-wise rate under any dependence between the
metrics. The cost is power: metrics that move together (recall@1, recall@3, MRR) are corrected
as if they were independent, so on a small suite a real regression may need to clear a higher
bar. Set `gate: false` on a metric to report it without letting it count.

## Power: what your suite can see

The report prints the smallest drop the suite can reliably detect:

```
MDE = (z(1 − α/2) + z(power)) · sd(d) / √n          (power = 0.8)
```

and the number of cases needed to detect a drop of `max_drop`. If the printed minimum
detectable drop is bigger than the drops you care about, the suite is too small or too noisy
to protect you from them, and you will see *inconclusive* rather than a pass.

## Flaky cases

A case is *flaky* when its own trials differ by at least `flaky_threshold` (default 0.5) on a
gated metric. Flaky cases add noise to every comparison; the report lists them so the case, the
expected answer or the rubric can be tightened.

## When the ground moves

- **Model aliases.** If the configured model is unchanged but the model id the provider
  reports back differs from the baseline's (an alias like `claude-x` now points to a new
  snapshot), a regression is downgraded to *inconclusive* with the reason, because the change
  cannot be attributed to the pull request. The same applies to the judge model.
- **Errored trials.** If more than `max_error_rate` (default 10%) of trials error, the run is
  reported as broken (exit code 2), not as a verdict. Errored trials are never scored as zero.

## What the simulations check

Run them with `npm test -- calibration`, or tighter with `ERRORBAR_SIMS=20000 npm test -- calibration`.

| Claim | Measured |
|---|---|
| With no real change, false-regression rate (nominal 2.5%, `max_drop` 0) | 3.3% at 20 cases, 2.9% at 40, 2.7% at 60, 2.5% at 120 |
| Same, on pass/fail scores with a few hard cases (the sparse case, where few flipped cases decide everything) | 0.7% at 24 cases with 1 trial, 2.2% at 60 cases with 3 trials |
| Power when the true drop equals the printed minimum detectable drop (target 80%) | 79.6% at 30 cases, 79.7% at 60, 79.8% at 120 |
| Case-level resampling vs. treating trials as independent, when effects differ by case | 2.85% vs. 11.9% |
| A real but small drop (−0.01) in a 400-case suite with `max_drop` 0.05 | does not fail the build |

These are properties of the method on synthetic data with the stated shapes. They are not a
guarantee for your data: heavy-tailed scores, strongly dependent cases (many near-duplicates)
or a biased judge are outside what they show.

## What it does not do

- **It does not calibrate the judge.** An LLM judge has its own error rate and its own biases;
  a judge that systematically prefers longer answers will pass longer answers. errorbar
  controls the judge's sampling noise (temperature 0, trials) and detects when the judge
  changes. Measuring the judge against human labels is on the [roadmap](../ROADMAP.md).
- **It assumes cases are exchangeable draws.** Many near-duplicate cases count as many cases
  and make the suite look better powered than it is.
- **It compares two runs.** It does not model drift over many runs.

## Reference

Evan Miller, [*Adding Error Bars to Evals: A Statistical Approach to Language Model
Evaluations*](https://arxiv.org/abs/2411.00640), 2024. errorbar follows its principles (an eval
is an experiment, pair on the same questions, account for clustered observations, plan with
power) and uses a case-level bootstrap where the paper uses analytic standard errors.

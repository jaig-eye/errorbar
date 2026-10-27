<!-- errorbar:report -->

## errorbar ❌ regression in support-bot › helpfulness

### support-bot

| metric | base | head | Δ (95% CI) | verdict |
|---|---:|---:|---:|---|
| `helpfulness` | 0.745 | 0.649 | -0.096 [-0.101, -0.091] | ❌ regression |
| `has_citation` | 0.960 | 0.960 | 0.000 [0.000, 0.000] | ✓ no change |
| `recall@5` | 0.873 | 0.873 | 0.000 [0.000, 0.000] | ✓ no change |

<sub>59 paired cases × 3 trials · detects drops ≥ 0.01 at 80% power · 7 flaky cases · 1.5k tokens · 1m 12s · baseline main@abcdef0</sub>

<details><summary>Biggest drops: support-bot › helpfulness</summary>

**case-16**: 0.614 → 0.477

Input: `{"q":"case-16"}`

Before:
```text
Answer text for case 16, version old.
```

After:
```text
Answer text for case 16, version new.
```

**case-35**: 0.870 → 0.733

Input: `{"q":"case-35"}`

Before:
```text
Answer text for case 35, version old.
```

After:
```text
Answer text for case 35, version new.
```

**case-22**: 0.643 → 0.507

Input: `{"q":"case-22"}`

Before:
```text
Answer text for case 22, version old.
```

After:
```text
Answer text for case 22, version new.
```

</details>

<details><summary>Flaky cases: support-bot (7)</summary>

These cases scored very differently from one trial to the next. Tightening their expected answers or rubric makes the gate more sensitive.

- `case-01` › `has_citation`: 0.000 to 1.000 across trials
- `case-10` › `has_citation`: 0.000 to 1.000 across trials
- `case-19` › `has_citation`: 0.000 to 1.000 across trials
- `case-28` › `has_citation`: 0.000 to 1.000 across trials
- `case-37` › `has_citation`: 0.000 to 1.000 across trials
- `case-46` › `has_citation`: 0.000 to 1.000 across trials
- `case-55` › `has_citation`: 0.000 to 1.000 across trials

</details>

<details><summary>Dataset changes: support-bot</summary>

Added, removed and edited cases are not compared, because they are not the same question on both sides.

- Added (1): `case-61`
- Edited (1): `case-04`

</details>

# Contributing

Thanks for helping. Bug reports, small fixes and new ideas are all welcome.

## Set up

You need Node 24 or newer.

```bash
git clone https://github.com/jaig-eye/errorbar.git
cd errorbar
npm ci
npm run check     # types, lint, tests
```

| Script | |
|---|---|
| `npm run check` | Typecheck, lint and run the tests. Run this before you push. |
| `npm test` | Tests only. `npm test -- calibration` runs the statistical simulations. |
| `npm run format` | Fix formatting and import order with Biome. |
| `npm run build` | Rebuild `dist/`. |
| `node dist/cli.js run --config examples/support-bot/errorbar.yaml` | Try the built CLI. |

## `dist/` is committed

A GitHub Action runs straight from the repository, so `dist/index.js` has to be there and has to
match the source. CI rebuilds it and fails if the committed copy differs. After changing
anything under `src/`, run `npm run build` and commit the result.

## Changing the statistics

The statistics are the point of the project, so changes to them are held to a higher bar:

- Explain the change in terms of a failure it fixes: a wrong false-alarm rate, a wrong interval,
  a verdict that surprised someone.
- The simulations in `test/calibration.test.ts` must keep passing. If you change what they
  assert, say why in the pull request, with numbers (`ERRORBAR_SIMS=20000 npm test -- calibration`
  gives tighter ones).
- Update `docs/methodology.md` if a number or a rule there changes.

## Style

- TypeScript, strict. Biome formats and lints; `npm run format` fixes what it can.
- Match the code around you. Prefer a small function with a clear name over a comment.
- Test behaviour, not implementation. A new metric, provider option or verdict rule needs a test.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(metrics): add exact-match normalisation`, `fix(compare): ...`, `docs: ...`.

## Dependencies

Runtime dependencies are few on purpose, and the LLM providers use plain `fetch` rather than
SDKs. Before adding a dependency, open an issue. We pin exact versions and only take releases
that are at least seven days old.

## Pull requests

Keep them focused. Say what changed and why; link the issue if there is one. The template has a
short checklist.

# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub:
[Report a vulnerability](https://github.com/jaig-eye/errorbar/security/advisories/new).
Do not open a public issue for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with it. You will get
an answer as soon as the maintainer can give one, and credit in the fix if you want it.

## Scope

In scope: the Action, the CLI, and anything that could leak a secret, run code from an untrusted
pull request with secrets, trust an attacker-controlled baseline, or let model output break out
of the report.

Out of scope: weaknesses that need the ability to edit `errorbar.yaml` or the workflow (that
person already controls the gate and the job; see [docs/security.md](docs/security.md) for how to
protect those), and the behaviour of the model providers.

## Supported versions

Fixes go to the latest release.

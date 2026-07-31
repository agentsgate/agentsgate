<!--
Security fixes: please do not open a public PR for an unreported vulnerability.
Follow SECURITY.md first so a fix and disclosure can land together.
-->

## What this changes

<!-- What behaviour differs after this PR, and why. Link the issue if there is one. -->

## How it was verified

<!--
What you actually ran, and what it printed. "Tests pass" is less useful than
the command and its result.
-->

- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm test`

## Checklist

- [ ] Tests cover the new behaviour, and fail without the change
- [ ] No credentials, personal paths, or machine-specific values added
  (`npm run check:pii`)
- [ ] Docs updated if a command, config key, or endpoint changed
  (`docs/cli.md` for commands and flags, `docs/configuration.md` for config keys)
- [ ] CHANGELOG updated under `[Unreleased]` if user-visible
- [ ] SECURITY.md updated if this changes the trust model, an outbound request,
      or an authentication path

## Notes for reviewers

<!-- Trade-offs, alternatives you rejected, or anything you are unsure about. -->

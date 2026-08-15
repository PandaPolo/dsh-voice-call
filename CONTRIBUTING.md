# Contributing to dsh-voice-call

Thanks for wanting to help! This project is small, honest, and local-first —
please keep contributions the same.

## Ground rules

- **Keep it local-first.** Cloud backends (openai STT, edge-tts) exist only
  behind explicit user configuration; never make them automatic.
- **Keep sessions resumable.** `durableEvents` stays off by default — the rc.6
  harness refuses session logs containing unknown event types. Do not "fix"
  this by writing `voice/*` events without a harness-level registration
  surface.
- **Tests are the contract.** Every behavior change ships with unit tests;
  the suite must stay green (`pnpm test`).

## Development

```bash
pnpm install
pnpm typecheck   # server + client tsconfigs
pnpm build       # tsc + web client bundle
pnpm test        # node --test
```

## Report a bug

Open an issue with: what you did, what you expected, what happened (paste the
error), your platform (OS, Node version, DSH version), and your
`tts`/`stt`/`callMode` configuration (paths may be redacted).

## Send a pull request

1. Fork the repo and branch from `main`.
2. Make the change with tests.
3. Run `pnpm typecheck && pnpm build && pnpm test` locally.
4. Open the PR; CI runs the same checks on Ubuntu and Windows.

## Credits note

This project was implemented by an AI agent, with a human partner who had the
idea and never gave up. If you contribute, you become part of that story —
please leave the credits section in the README intact.

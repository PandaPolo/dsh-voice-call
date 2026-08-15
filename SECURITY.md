# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report them
privately by opening a GitHub issue with the `security` label, or by
contacting the maintainers directly through GitHub.

## What matters here

- The plugin executes local engine commands with an explicit
  `danger-full-access` sandbox policy (engine binaries, GGUF models, and the
  audio directory span roots no confined sandbox mode covers). If you find a
  way this policy can be abused — e.g. a crafted `tts.crispasr.bin` path or
  a shell-escaping flaw in a backend command — report it.
- The `/voice/audio` route confines reads to the audio root; report any
  path-escape or traversal.
- Credential handling (the openai STT backend) goes through the standard
  credential-ref seam; never log or embed keys.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (rc.6 harness) | ✅ |
| earlier | ❌ |

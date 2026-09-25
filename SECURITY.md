# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem — that publishes it
before there is a fix.

Report it privately through GitHub's **private vulnerability reporting**: on the
repository page open *Security → Report a vulnerability* and file an advisory
there. That channel is private to you and the maintainers and is the only place
to write up an exploit. If it is unavailable for your account, open a regular
issue titled `security: <one-line summary>` with **no** details in the body and
wait for a maintainer to reply with a private venue — an issue is not a private
channel, so the detail has to come afterwards.

## What matters here

The plugin runs local speech engines, keeps private audio on disk, and puts an
HTTP surface on a loopback port. The trust boundaries worth attacking:

- **Shell construction.** Engine commands are assembled as argv lists and
  quoted for the shell that will read them (`buildCommandLine` in
  `src/backends/quote.ts` is the only builder). Anything a model can influence —
  the text to be spoken, a file to transcribe, a configured binary path — that
  reaches a command line *unquoted* is a report. So is a token that survives as
  two arguments.
- **The HTTP surface.** The host's webserver performs no authentication and
  `host` is configurable to `0.0.0.0`. State-changing routes therefore check
  `Sec-Fetch-Site` (falling back to `Origin` versus `Host`) in
  `src/web-guard.ts`: a request that refuses to answer that question must not
  delete files, start a 1.9 GB download, or answer a call on the human's behalf.
  A bypass of that gate — a browser context that sends neither header while
  still being remote-originated — is a report.
- **Path confinement.** `/voice/audio` serves only what is under the audio root,
  and `transcribe({ source: { file } })` accepts only a file inside it. Any path
  escape, including through percent-encoding, a symlink, or a configured
  `audioDir` that points elsewhere, is a report.
- **Deletion scope.** 清理本地文件 removes only what lives under the voice root,
  and `cleanableRoot` refuses roots it does not own (a drive root, the working
  directory, the home directory, the temp dir). A configuration in which the
  cleaner reaches outside the root — including a hand-written `D:\crispasr`-style
  path the plugin was never given — is a report.
- **Credentials.** The OpenAI STT backend reads its key through the standard
  credential-ref seam. A key or a token-bearing URL appearing in a log, an error
  message, or a tool result is a report.

## Supported versions

| Version | Supported |
|---|---|
| the version published on npm | ✅ |
| the `main` branch | ✅ |
| earlier releases | ❌ — reproduce against the current one first |

The harness baseline is declared in `package.json` under `peerDependencies`
(`@deepseek-ai/dsh-*`); findings are only actionable against a plugin running on
a harness within that range.

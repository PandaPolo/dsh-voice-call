/**
 * Shell-quote one argument for the `sh -c` command strings handed to
 * `ctx.shell`. Single quotes with the POSIX `'\''` escape are the most
 * portable form.
 *
 * @module dsh-voice/backends/quote
 */

/** Quote one argument for a POSIX shell. */
export function shq(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Join several quoted arguments into one command line. */
export function shqJoin(...parts: string[]): string {
  return parts.map(shq).join(' ');
}

/**
 * Build a command line: tokens starting with `-` are emitted raw (safe flag
 * literals), every other token is shell-quoted. Use for `ctx.shell` command
 * strings where flags must stay unquoted (a quoted `-o` would be treated as
 * the program name by `sh`).
 */
export function shqFlags(...tokens: string[]): string {
  return tokens.map((token) => (token.startsWith('-') ? token : shq(token))).join(' ');
}

/**
 * The shell runner used by DSH is platform-dependent: POSIX shells on
 * darwin/linux, PowerShell on win32. These helpers build correct,
 * injection-safe command lines for both families (PowerShell:
 * `& 'path'` + `''` escape; POSIX: `shq` + `'\''` escape).
 */

/** Quote one argument for the current platform's shell (POSIX or PowerShell). */
export function quoteForShell(token: string | undefined): string {
  const value = token ?? '';
  // win32: the dsh shell layer runs PowerShell; `''` is the escape for `'`.
  if (process.platform === 'win32') {
    return `'${value.replaceAll("'", "''")}'`;
  }
  return shq(value);
}

/** Invoke a program path with pre-quoted arguments on the current shell. */
export function invokeForShell(program: string, quotedArgs: string): string {
  if (process.platform === 'win32') {
    // PowerShell: `& 'path'` is the call operator for a quoted program path.
    return `& ${quoteForShell(program)} ${quotedArgs}`.trimEnd();
  }
  return `${shq(program)} ${quotedArgs}`.trimEnd();
}

/** Join argv tokens into one shell command line (platform-aware quoting). */
export function buildCommandLine(tokens: readonly string[]): string {
  if (tokens.length === 0) return '';
  const [program, ...args] = tokens;
  const quoted = args.map((token) => quoteForShell(token)).join(' ');
  return invokeForShell(program ?? '', quoted);
}

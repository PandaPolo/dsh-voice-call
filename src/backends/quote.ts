/**
 * Shell quoting for the command strings handed to `ctx.shell`.
 *
 * There is exactly one entry point, {@link buildCommandLine}, and it takes an
 * argv array. That shape is the whole point: the moment a backend is handed a
 * list of arguments it cannot accidentally concatenate somebody's text into a
 * command line, and it cannot pick between two quoting systems either.
 *
 * This file used to carry both. `shqFlags` looked at each token and emitted
 * anything starting with `-` *raw*, on the theory that a leading dash marks a
 * flag and a flag must stay unquoted. Two things were wrong with that. A token
 * that begins with `-` is not necessarily a flag — the text of a spoken message
 * can, and on a markdown-replying agent regularly does — and the previous line
 * then pastes it into the shell with `'; rm -rf ~'` still live in it. And on
 * `win32` the runner is PowerShell, where the `'\''` idiom is not an escaped
 * quote but the end of a string, so any path containing an apostrophe left the
 * argument position and entered the statement position. Quoting a genuine flag
 * costs nothing in either shell: a quoted word is still a word.
 *
 * @module dsh-voice/backends/quote
 */

/** Quote one argument for a POSIX shell. */
export function shq(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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

/**
 * Join an argv array into one shell command line, with every token quoted for
 * the shell that will read it — flags included, because both shell families
 * pass a quoted word through unchanged and neither one mistakes it for a
 * command name when it is not in first position.
 */
export function buildCommandLine(tokens: readonly string[]): string {
  if (tokens.length === 0) return '';
  const [program, ...args] = tokens;
  const quoted = args.map((token) => quoteForShell(token)).join(' ');
  return invokeForShell(program ?? '', quoted);
}

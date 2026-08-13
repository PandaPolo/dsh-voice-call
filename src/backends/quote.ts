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

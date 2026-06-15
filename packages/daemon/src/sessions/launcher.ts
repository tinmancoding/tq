import { spawn } from "node:child_process";

export interface LaunchInput {
  cwd: string;
  cmd: string;
  actor: string;
  /** Optional pi session file to resume. */
  sessionFile?: string;
}

export interface LaunchResult {
  launched: boolean;
  /** The command string (always returned; the only thing shown in print mode). */
  command: string;
}

/**
 * Launch a terminal pi session in a workspace. If `launcherTemplate` is set,
 * substitute `{cwd}`/`{cmd}` and spawn it detached (with `TQ_ACTOR` in env).
 * If unset, return the command string for the UI to display/copy (print
 * fallback). No request-supplied command — `cmd` is config-fixed.
 */
export function launchSession(launcherTemplate: string, input: LaunchInput): LaunchResult {
  const cmd = input.sessionFile
    ? `${input.cmd} --session ${shellQuote(input.sessionFile)}`
    : input.cmd;
  const command = `cd ${shellQuote(input.cwd)} && ${cmd}`;

  if (!launcherTemplate.trim()) {
    return { launched: false, command };
  }

  const rendered = launcherTemplate
    .replaceAll("{cwd}", input.cwd)
    .replaceAll("{cmd}", cmd);

  const child = spawn("/bin/sh", ["-c", rendered], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, TQ_ACTOR: input.actor },
  });
  child.unref();
  return { launched: true, command: rendered };
}

/** Minimal POSIX single-quote escaping for safe substitution. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

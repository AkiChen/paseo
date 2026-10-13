import type { AgentSlashCommand } from "../../agent-sdk-types.js";
import type { DshCommandDescriptor } from "./bridge.js";

/**
 * DeepSeek Harness's slash commands, as Paseo's slash menu.
 *
 * The names, descriptions, and argument hints come from the registry inside the
 * ACP process, so the menu cannot drift from what that process can run. They
 * are commands, never skills: DSH has no skill-shaped entry in this catalog.
 */
export function mapDshSlashCommands(
  commands: readonly DshCommandDescriptor[],
): AgentSlashCommand[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
    kind: "command",
  }));
}

/**
 * One complete slash-command line, or null when the text is not one.
 *
 * The shape is DSH's own: a name, then either the end of the line or the input
 * it takes. Text that merely starts with a slash — a path, prose — does not
 * match, and stays an ordinary prompt.
 */
const COMMAND_LINE = /^\/[a-z][a-z0-9_-]*(?=$|[\t\n\r ])/u;

export interface DshSlashCommandInvocation {
  /** Command name without the leading slash. */
  name: string;
  /** The complete line, exactly as the user wrote it, for DSH to parse. */
  line: string;
}

export function parseDshSlashCommandLine(text: string): DshSlashCommandInvocation | null {
  const line = text.trim();
  const match = COMMAND_LINE.exec(line);
  if (match === null) return null;
  return { name: line.slice(1, match[0].length), line };
}

// SPDX-License-Identifier: MIT
// Command-line parsing for the sope executable. Pure: no terminal, no libsope.

import { parseEffort, type Effort } from "./agent/effort";
import { parseMode, type PermissionMode } from "./agent/permissions";

export interface CliOptions {
  print: boolean;
  prompt?: string;
  model?: string;
  provider?: string;
  baseUrl?: string;
  /** --effort; "" for the model's default. */
  effort?: Effort;
  /** --permissions, or --allow-all (full). */
  permissions?: PermissionMode;
  /** --image files, attached to the prompt. */
  images: string[];
  version: boolean;
  help: boolean;
}

export const USAGE = `Usage: sope [options] [prompt]

Starts the interactive TUI in the current directory. A prompt, if given, is
sent as the first message.

Options:
  -p, --print            answer the prompt (and/or stdin) without the TUI, then exit
  -m, --model <name>     model to use (default: $SOPE_MODEL or glm-5.3)
      --provider <name>  openai or mock (default: openai when an API key is set)
      --base-url <url>   OpenAI-compatible endpoint (default: $SOPE_BASE_URL)
  -i, --image <file>     attach an image to the prompt (PNG, JPEG, GIF, WebP; repeatable)
      --effort <level>   how long the model thinks: low, medium, high, xhigh
                           (also none, minimal; default: the model's)
      --permissions <m>  who approves edits, commands and fetches:
                           ask   ask for approval every time
                           auto  approve for me: only risky steps ask (default)
                           full  full access: nothing asks
      --allow-all        same as --permissions full
  -v, --version          print versions and exit
  -h, --help             show this help

Configuration: ~/.config/sope/config (KEY=VALUE lines) or environment
variables: SOPE_API_KEY, SOPE_MODEL, SOPE_IMAGE_MODEL (default kimi-k3 on the
default endpoint; "off" sends images to SOPE_MODEL), SOPE_BASE_URL,
SOPE_PROVIDER, SOPE_PERMISSIONS, SOPE_REASONING_EFFORT, SOPE_COMPACT_THRESHOLD, SOPE_CONTEXT_WINDOW, SOPE_DB. SOPE_LIB loads a different libsope.
SOPE_TRACE_DIR enables bounded metadata-only JSONL diagnostics (environment only).`;

export class CliError extends Error {}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { print: false, images: [], version: false, help: false };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || (inline === undefined && v.startsWith("-"))) throw new CliError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "-p":
      case "--print":
        opts.print = true;
        break;
      case "-m":
      case "--model":
        opts.model = value();
        break;
      case "--provider":
        opts.provider = value();
        if (!["openai", "mock"].includes(opts.provider)) throw new CliError(`unknown provider ${opts.provider}`);
        break;
      case "--base-url":
        opts.baseUrl = value();
        break;
      case "-i":
      case "--image":
        opts.images.push(value());
        break;
      case "--permissions": {
        const v = value();
        const mode = parseMode(v);
        if (!mode) throw new CliError(`unknown permission mode ${v} (ask, auto or full)`);
        opts.permissions = mode;
        break;
      }
      case "--effort": {
        const v = value();
        const effort = parseEffort(v);
        if (effort === undefined) throw new CliError(`unknown effort ${v} (default, none, minimal, low, medium, high or xhigh)`);
        opts.effort = effort;
        break;
      }
      case "--allow-all":
        opts.permissions = "full";
        break;
      case "-v":
      case "--version":
        opts.version = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "--":
        words.push(...argv.slice(i + 1));
        i = argv.length;
        break;
      default:
        if (arg.startsWith("-") && arg !== "-") throw new CliError(`unknown option ${arg}`);
        words.push(arg);
    }
  }
  if (words.length) opts.prompt = words.join(" ");
  return opts;
}

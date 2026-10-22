// SPDX-License-Identifier: MIT
// Colors are chosen to read on both dark and light backgrounds; the UI keeps
// the terminal's own foreground and background for body text.

export const palette = {
  accent: 0xa78bfa, // violet: brand, assistant
  user: 0x60a5fa, // blue
  tool: 0xe0a458, // amber
  code: 0x7dd3c0, // teal: inline code and code blocks
  ok: 0x4ade80, // green
  error: 0xf87171, // red
  muted: 0x8b8f9c, // secondary text
  faint: 0x565b69, // rules and borders
} as const;

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

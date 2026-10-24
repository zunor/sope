// SPDX-License-Identifier: MIT
// Colors are chosen to read on both dark and light backgrounds; the UI keeps
// the terminal's own foreground and background for body text. Surfaces
// (tabs, panels, diff lines) are shades of the terminal's actual background,
// which the terminal reports (OSC 11) shortly after start.

import { luminance, mix } from "./render/color";

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

/** Spinner of tool calls still running in the transcript. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_MS = 80;

/** Background shades for raised and tinted areas. */
export interface Surfaces {
  /** Subtle backgrounds for one-row session tabs. */
  tab: number;
  tabHover: number;
  tabSelected: number;
  /** Floating panels (the session list). */
  panel: number;
  /** The selected row of a panel. */
  panelSelected: number;
  /** Diff lines. */
  added: number;
  removed: number;
  /** Transcript search hits other than the current one. */
  match: number;
}

const DARK_GUESS = 0x1e2027; // the background until (or unless) the terminal says

export function surfaces(bg: number | null): Surfaces {
  const base = bg ?? DARK_GUESS;
  const dark = luminance(base) < 0.5;
  const lift = (t: number) => (dark ? mix(base, 0xffffff, t) : mix(base, 0x000000, t * 0.7));
  return {
    tab: lift(0.10),
    tabHover: lift(0.15),
    tabSelected: lift(0.21),
    panel: lift(0.08),
    panelSelected: lift(0.17),
    added: mix(base, 0x2ea043, dark ? 0.2 : 0.16),
    removed: mix(base, 0xf85149, dark ? 0.2 : 0.14),
    match: mix(base, palette.tool, dark ? 0.3 : 0.35),
  };
}

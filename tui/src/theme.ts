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
  /** Inactive tab. */
  tab: number;
  /** Active tab. */
  tabActive: number;
  /** Where a tab's right edge fades to: its soft shadow. */
  shadow: number;
  /** Floating panels (the session list). */
  panel: number;
  /** The selected row of a panel. */
  panelSelected: number;
  /** Diff lines. */
  added: number;
  removed: number;
}

const DARK_GUESS = 0x1e2027; // the background until (or unless) the terminal says

export function surfaces(bg: number | null): Surfaces {
  const base = bg ?? DARK_GUESS;
  const dark = luminance(base) < 0.5;
  const lift = (t: number) => (dark ? mix(base, 0xffffff, t) : mix(base, 0x000000, t * 0.7));
  return {
    tab: lift(0.06),
    tabActive: lift(0.15),
    shadow: dark ? mix(base, 0x000000, 0.35) : mix(base, 0x000000, 0.14),
    panel: lift(0.08),
    panelSelected: lift(0.17),
    added: mix(base, 0x2ea043, dark ? 0.2 : 0.16),
    removed: mix(base, 0xf85149, dark ? 0.2 : 0.14),
  };
}

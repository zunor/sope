// SPDX-License-Identifier: MIT
// Colors are 0xRRGGBB numbers, or -1 for the terminal's default color.

export const DEFAULT_COLOR = -1;

/** Whether the terminal understands 24-bit SGR colors. SOPE_TRUECOLOR=0/1 overrides detection. */
export function detectTruecolor(env = process.env): boolean {
  if (env.SOPE_TRUECOLOR === "0") return false;
  if (env.SOPE_TRUECOLOR === "1") return true;
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return true;
  if (env.TERM_PROGRAM === "Apple_Terminal") return false;
  const term = env.TERM ?? "";
  return /kitty|ghostty|wezterm|alacritty|direct/.test(term) || ["iTerm.app", "WezTerm", "vscode"].includes(env.TERM_PROGRAM ?? "");
}

/** Nearest xterm-256 palette index for an RGB color. */
export function to256(rgb: number): number {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 24);
  }
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/** The color `t` of the way from `a` to `b` (0..1). Default colors do not mix. */
export function mix(a: number, b: number, t: number): number {
  if (a === DEFAULT_COLOR || b === DEFAULT_COLOR || t <= 0) return a;
  if (t >= 1) return b;
  const ch = (shift: number) => {
    const x = (a >> shift) & 0xff;
    return Math.round(x + (((b >> shift) & 0xff) - x) * t) << shift;
  };
  return ch(16) | ch(8) | ch(0);
}

/** The color in an OSC color reply such as "11;rgb:1e1e/1e1e/1e1e" (1 to 4 hex digits per channel). */
export function parseOscColor(reply: string): number | null {
  const m = /rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(reply);
  if (!m) return null;
  const channel = (hex: string) => Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255);
  return (channel(m[1]!) << 16) | (channel(m[2]!) << 8) | channel(m[3]!);
}

/** Relative luminance, 0 (black) to 1 (white). */
export function luminance(rgb: number): number {
  return (0.2126 * ((rgb >> 16) & 0xff) + 0.7152 * ((rgb >> 8) & 0xff) + 0.0722 * (rgb & 0xff)) / 255;
}

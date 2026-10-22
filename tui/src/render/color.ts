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

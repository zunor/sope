// SPDX-License-Identifier: MIT
// Run in your terminal: bun scripts/preview-meteor.ts. No API calls or session writes.
import { Renderer } from "../tui/src/render/renderer";
import { InputParser } from "../tui/src/term/input";
import { Terminal } from "../tui/src/term/terminal";
import { pixelMeteor } from "../tui/src/ui/pixel-meteor";
import { drawStatus } from "../tui/src/ui/status";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Run this preview in an interactive terminal.");
  process.exit(1);
}
const term = new Terminal();
const renderer = new Renderer((s) => term.write(s), term.truecolor, term.graphics);
const parser = new InputParser();
const started = performance.now();
let ticker: ReturnType<typeof setInterval>;
function stop(): void {
  clearInterval(ticker);
  term.leave();
  process.exit(0);
}
function render(): void {
  const now = performance.now() - started;
  const buf = renderer.begin(term.cols, term.rows);
  buf.text(2, 1, "Square meteor · one row · 3 seconds per orbit", { fg: 0xa78bfa });
  buf.text(2, 3, term.graphics.supported ? "Kitty graphics confirmed: pixel animation" : "Character fallback (waiting for graphics support, or unsupported)");
  if (term.cols >= 24 && term.rows >= 8) {
    drawStatus(buf, 2, 5, term.cols - 4, { verb: "Thinking", color: 0xa78bfa, elapsedMs: now, rate: null, tip: null }, now, term.graphics.supported);
    if (term.graphics.supported) renderer.image = pixelMeteor(2, 5, 0xa78bfa, now);
    buf.text(2, 7, "Press q, Esc or Ctrl+C to exit.");
  }
  renderer.end();
}
term.onInput((data) => {
  for (const ev of parser.feed(data)) {
    if (ev.type === "apc") term.graphics.reply(ev.data);
    else if (ev.type === "key" && (ev.name === "escape" || (ev.ctrl && ev.name === "c"))) stop();
    else if (ev.type === "text" && ev.text.includes("q")) stop();
  }
  if (parser.hasPending) setTimeout(() => {
    for (const ev of parser.flush()) if (ev.type === "key" && ev.name === "escape") stop();
  }, 50);
});
term.onResize(() => { renderer.invalidate(); render(); });
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
try {
  term.enter();
  render();
  ticker = setInterval(render, 50);
} catch (error) {
  term.leave();
  throw error;
}

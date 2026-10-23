// SPDX-License-Identifier: MIT
// Local CPU microbenchmarks; run with bun scripts/bench-tui-review.ts.
import { renderMarkdown, slice } from "../tui/src/ui/markdown";
import { ChatView } from "../tui/src/ui/chat";
import { CellBuffer } from "../tui/src/render/buffer";

function measure(name: string, run: () => void): void {
  run();
  const times = Array.from({ length: 7 }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  console.log(`${name}: median ${times[3]!.toFixed(3)} ms`);
}

const styled = renderMarkdown("**styled row**\n".repeat(20_000));
measure("slice 20k styled rows", () => {
  for (const run of styled.runs) slice(styled, run.start, run.end, {});
});

const chat = new ChatView();
for (let i = 0; i < 2000; i++) chat.add({ role: "tool", title: "bash", text: "some command output\n".repeat(20) });
const buf = new CellBuffer(100, 30);
const rect = { x: 0, y: 0, w: 100, h: 30 };
measure("repaint 2k folded tools", () => { chat.render(buf, rect, "*"); });

const long = new ChatView();
long.add({ role: "assistant", text: "a plain output row\n".repeat(100_000) });
measure("repaint 100k transcript rows", () => { long.render(buf, rect, "*"); });

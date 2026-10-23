// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { KittyGraphics } from "../src/render/graphics";
import { Renderer } from "../src/render/renderer";
import { InputParser } from "../src/term/input";
import { meteorPixels, pixelMeteor, METEOR_ORBIT_MS } from "../src/ui/pixel-meteor";

function supportedGraphics(): KittyGraphics {
  const graphics = new KittyGraphics();
  const query = graphics.query({});
  const id = /i=(\d+)/.exec(query)![1];
  graphics.reply(`Gi=${id};OK`);
  return graphics;
}

test("only a successful capability reply enables pixels; disabled and multiplexed sessions stay text", () => {
  const graphics = new KittyGraphics();
  const id = /i=(\d+)/.exec(graphics.query({}))![1];
  const image = pixelMeteor(0, 0, 0xa78bfa, 0);
  expect(graphics.render(image)).toBe("");
  graphics.reply(`Gi=${id};ENOTSUP`);
  graphics.reply("Gi=1;OK");
  expect(graphics.supported).toBe(false);
  graphics.reply(`Gi=${id};OK`);
  expect(graphics.render(image)).toContain("a=T");
  for (const env of [{ SOPE_GRAPHICS: "0" }, { TMUX: "session" }, { STY: "session" }, { ZELLIJ: "1" }, { TERM: "dumb" }]) {
    expect(graphics.query(env)).toBe("");
    graphics.reply(`Gi=${id};OK`);
    expect(graphics.supported).toBe(false);
  }
});

test("graphics replies split at any byte are consumed, never inserted into the editor", () => {
  const reply = "\x1b_Gi=1397706821;OK\x1b\\";
  const enc = new TextEncoder();
  for (let split = 1; split < reply.length; split++) {
    const parser = new InputParser();
    expect(parser.feed(enc.encode(reply.slice(0, split)))).toEqual([]);
    expect(parser.feed(enc.encode(reply.slice(split) + "hi"))).toEqual([
      { type: "apc", data: "Gi=1397706821;OK" }, { type: "text", text: "hi" },
    ]);
  }
});

test("frames replace only the owned image; idle, moving and repainting clean up placements", () => {
  const graphics = supportedGraphics();
  const image = pixelMeteor(2, 10, 0xa78bfa, 0);
  const first = graphics.render(image);
  expect(first).toContain("\x1b[11;3H");
  expect(first).toContain("c=2,r=1,C=1,q=2");
  expect(first).toContain(image.data);
  expect(graphics.render(image)).toBe("");
  const moved = graphics.render({ ...image, y: 9 });
  expect(moved.indexOf("a=d,d=I")).toBeLessThan(moved.indexOf("a=T"));
  expect(graphics.render(image, true)).toContain("a=T");
  expect(graphics.render(null)).toContain("a=d,d=I");
  expect(graphics.clear()).toBe("");
});

test("renderer paints graphics within synchronized output and restores the editor cursor", () => {
  const graphics = supportedGraphics();
  let output = "";
  const renderer = new Renderer((s) => { output = s; }, true, graphics);
  renderer.begin(20, 5);
  renderer.image = pixelMeteor(1, 1, 0xa78bfa, 0);
  renderer.cursor = { x: 3, y: 4, visible: true };
  renderer.end();
  expect(output.indexOf("a=T")).toBeGreaterThan(output.indexOf("\x1b[?2026h"));
  expect(output).toEndWith("\x1b[0m\x1b[5;4H\x1b[?25h\x1b[?2026l");
  renderer.begin(20, 5); // no status requested on this frame
  renderer.end();
  expect(output).toContain("a=d,d=I");
});

test("pixel meteor has a bright head, fading transparent tail, and a slow square orbit", () => {
  expect(METEOR_ORBIT_MS).toBe(3000);
  for (const [phase, x, y] of [[0, 4, 4], [0.25, 19, 4], [0.5, 19, 19], [0.75, 4, 19]]) {
    const pixels = meteorPixels(0xa78bfa, phase!);
    expect(pixels.length).toBe(24 * 24 * 4);
    expect(pixels[(y! * 24 + x!) * 4 + 3]).toBe(255);
    expect(pixels[(12 * 24 + 12) * 4 + 3]).toBe(0);
    expect(pixels[3]!).toBeLessThanOrEqual(2);
  }
  const pixels = meteorPixels(0xa78bfa, 0);
  expect(pixels[(4 * 24 + 6) * 4 + 3]!).toBe(255); // broad bright core two pixels from the head
  expect([...pixels.subarray((4 * 24 + 4) * 4, (4 * 24 + 4) * 4 + 3)]).toEqual([255, 255, 255]);
  expect(pixels[(10 * 24 + 4) * 4 + 3]!).toBeGreaterThan(pixels[(18 * 24 + 4) * 4 + 3]!);
  expect(pixelMeteor(0, 0, 0xa78bfa, 3000).data).toBe(pixelMeteor(0, 0, 0xa78bfa, 0).data);
});

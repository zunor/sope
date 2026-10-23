// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeImage, imageRefs, imageType, pastedImagePath, readImageFile } from "../src/agent/images";
import { agentOptions, loadConfig } from "../src/config";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

test("image types by signature", () => {
  expect(imageType(PNG)).toBe("image/png");
  expect(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe1]))).toBe("image/jpeg");
  expect(imageType(new TextEncoder().encode("GIF89a.."))).toBe("image/gif");
  expect(imageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  expect(imageType(new TextEncoder().encode("hello"))).toBeNull();
});

test("a dragged file arrives as its path, quoted or escaped", () => {
  const dir = mkdtempSync(join(tmpdir(), "sope img-"));
  try {
    const file = join(dir, "my shot.png");
    writeFileSync(file, PNG);
    writeFileSync(join(dir, "notes.txt"), "x");
    expect(pastedImagePath(file.replace(/ /g, "\\ "))).toBe(file);
    expect(pastedImagePath(`'${file}' `)).toBe(file);
    expect(pastedImagePath(`file://${encodeURI(file)}`)).toBe(file);
    expect(pastedImagePath("my shot.png", dir)).toBe(file);
    expect(pastedImagePath(join(dir, "notes.txt"))).toBeNull();
    expect(pastedImagePath(join(dir, "missing.png"))).toBeNull();
    expect(pastedImagePath(`${file}\n${file}`)).toBeNull();

    const img = readImageFile(file);
    expect(img).toMatchObject({ mediaType: "image/png", label: "my shot.png" });
    expect(describeImage(img)).toBe("my shot.png, png, 1 KB");
    writeFileSync(join(dir, "fake.png"), "not really");
    expect(() => readImageFile(join(dir, "fake.png"))).toThrow(/not a PNG, JPEG, GIF or WebP/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("image tokens in a message", () => {
  expect(imageRefs("compare [Image #2] with [Image #1] and [Image #2] again")).toEqual([2, 1]);
  expect(imageRefs("no images")).toEqual([]);
});

test("the image model: kimi-k3 on the default endpoint, configurable, off sends images to the main model", () => {
  const key = { SOPE_API_KEY: "k" };
  expect(agentOptions(loadConfig({}, key, {})).image_model).toBe("kimi-k3");
  expect(agentOptions(loadConfig({}, { ...key, SOPE_IMAGE_MODEL: "qwen-vl" }, {})).image_model).toBe("qwen-vl");
  expect(agentOptions(loadConfig({}, { ...key, SOPE_IMAGE_MODEL: "off" }, {})).image_model).toBeUndefined();
  expect(agentOptions(loadConfig({ baseUrl: "https://api.openai.com/v1" }, key, {})).image_model).toBeUndefined();
  expect(agentOptions(loadConfig({}, {}, {})).image_model).toBeUndefined(); // mock
  expect(agentOptions(loadConfig({ model: "kimi-k3" }, key, {})).image_model).toBeUndefined(); // already reads images
});

import { titleFrom } from "../src/session";

test("tab titles leave image tokens out", () => {
  expect(titleFrom("[Image #1] what is this?")).toBe("what is this?");
  expect(titleFrom("[Image #1] [Image #2]")).toBe("Image");
  expect(titleFrom("fix   the\nbug")).toBe("fix the");
});

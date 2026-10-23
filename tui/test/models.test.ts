// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { describeModel, parseModels } from "../src/agent/models";
import { CellBuffer } from "../src/render/buffer";
import { Store } from "../src/store";
import { ModelPicker } from "../src/ui/models";
import { drawBox } from "../src/ui/popup";

const row = (buf: CellBuffer, y: number) => buf.chars.slice(y * buf.width, (y + 1) * buf.width).join("").trimEnd();

const LISTED = {
  data: [
    { id: "glm-5.3", type: "chat", context_window: 1024000, capabilities: ["vision"] },
    { id: "bge-m3", type: "embedding", context_window: 128000 },
    { id: "kimi-k3", type: "chat", context_window: 1000000, capabilities: ["messages", "vision"] },
    { id: "qwen3-rerank", type: "rerank" },
    { id: "deepseek-v4-pro", type: "chat", context_window: 256000 },
    { id: "plain-model" }, // no type: an endpoint that does not say
  ],
};

test("the model list keeps chat models, sorted, with context and image support", () => {
  const models = parseModels(LISTED);
  expect(models.map((m) => m.id)).toEqual(["deepseek-v4-pro", "glm-5.3", "kimi-k3", "plain-model"]);
  expect(describeModel(models[1]!)).toBe("1M context · images");
  expect(describeModel(models[0]!)).toBe("256k context");
  expect(describeModel(models[3]!)).toBe("");
  expect(() => parseModels({ error: "nope" })).toThrow(/no model list/);
});

test("the picker shows recent models first, then the rest, starting on the current one", () => {
  const p = new ModelPicker("kimi-k3", ["glm-5.3", "kimi-k3"]);
  p.setModels(parseModels(LISTED));
  expect(p.rows.map((r) => ("header" in r ? `# ${r.header}` : r.model.id))).toEqual([
    "# Recent", "kimi-k3", "glm-5.3", "# All models", "deepseek-v4-pro", "plain-model",
  ]);
  expect(p.selected).toBe("kimi-k3");
  p.move(1);
  expect(p.selected).toBe("glm-5.3");
  p.move(10);
  expect(p.selected).toBe("plain-model");

  const buf = new CellBuffer(60, 8);
  const hits = p.render(buf, 0, 0, 60, 8);
  expect(row(buf, 0)).toBe("› Search models, or type a name                        4 / 4");
  expect(row(buf, 3)).toBe("  kimi-k3 ✓          1M context · images");
  expect(row(buf, 7)).toBe("› plain-model");
  expect(hits.map((h) => h.index)).toEqual([0, 1, 2, 3]);
});

test("typing searches; a name nothing lists can be used as typed", () => {
  const p = new ModelPicker("glm-5.3", []);
  p.setModels(parseModels(LISTED));
  p.type("k3");
  expect(p.rows.map((r) => ("model" in r ? r.model.id : r.header))).toEqual(["kimi-k3", "k3"]);
  expect(p.selected).toBe("kimi-k3");
  p.backspace();
  p.backspace();
  p.type("dsv4");
  expect(p.selected).toBe("deepseek-v4-pro"); // letters in order
  p.backspace(), p.backspace(), p.backspace(), p.backspace();
  expect(p.selected).toBe("glm-5.3"); // the search cleared: back on the current model
  p.type("my-own-model");
  expect(p.rows).toEqual([{ model: { id: "my-own-model" }, typed: true }]);
  expect(p.selected).toBe("my-own-model");
});

test("without a list (mock provider, an error) recent models and typed names still work", () => {
  const p = new ModelPicker("", ["kimi-k3"]);
  p.setError("401 Unauthorized");
  expect(p.selected).toBe("kimi-k3");
  const empty = new ModelPicker("", []);
  empty.setError("401 Unauthorized");
  const buf = new CellBuffer(70, 3);
  empty.render(buf, 0, 0, 70, 3);
  expect(row(buf, 2)).toBe("could not list models: 401 Unauthorized; type a model name");
});

test("models picked are remembered, most recent first", () => {
  const store = new Store(":memory:");
  store.usedModel("glm-5.3", 1);
  store.usedModel("kimi-k3", 2);
  store.usedModel("glm-5.3", 3);
  expect(store.recentModels()).toEqual(["glm-5.3", "kimi-k3"]);
  store.close();
});

test("a popup's key hints sit in its bottom edge, as many as fit", () => {
  const buf = new CellBuffer(40, 3);
  drawBox(buf, 0, 0, 40, 3, 0, "Title", [["↑↓", "select"], ["enter", "use"], ["esc", "close"]]);
  expect(row(buf, 0)).toBe("╭─ Title ──────────────────────────────╮");
  expect(row(buf, 2)).toBe("╰── ↑↓ select · enter use · esc close ─╯");
  const narrow = new CellBuffer(30, 3);
  drawBox(narrow, 0, 0, 30, 3, 0, "Title", [["↑↓", "select"], ["enter", "use"], ["esc", "close"]]);
  expect(row(narrow, 2)).toBe("╰──── ↑↓ select · enter use ─╯");
});

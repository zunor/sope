// SPDX-License-Identifier: MIT
// Reasoning effort (the option reasoning.effort): how long the model thinks
// before it answers. Which levels a model accepts is up to the model and its
// endpoint; "" sends none and leaves it to the model.
//
//   ""       Default     the model decides
//   low      Low         quick answers for small, clear tasks
//   medium   Medium      speed and depth balanced
//   high     High        longer thinking for hard tasks
//   xhigh    Extra high  the longest thinking
//
// none and minimal exist too (/effort minimal), for the models that take them.

export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORTS)[number] | "";

/** The stops of the /effort slider, in order. */
export const LEVELS: Array<{ id: Effort; label: string; description: string }> = [
  { id: "", label: "Default", description: "The model decides how long to think." },
  { id: "low", label: "Low", description: "Answers quickly: fine for small, clear tasks." },
  { id: "medium", label: "Medium", description: "Balances speed and depth." },
  { id: "high", label: "High", description: "Thinks longer before answering: better on hard tasks, slower, and uses more tokens." },
  { id: "xhigh", label: "Extra high", description: "Thinks the longest: for the hardest problems; the slowest, and the most tokens." },
];

/** A level, its label ("extra high") or "default"; undefined if neither. */
export function parseEffort(text: string): Effort | undefined {
  const t = text.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (t === "default" || t === "auto") return "";
  if (t === "extrahigh") return "xhigh";
  return (EFFORTS as readonly string[]).includes(t) ? (t as Effort) : undefined;
}

/** "Extra high", "Minimal", "Default". */
export function effortLabel(e: Effort): string {
  return LEVELS.find((l) => l.id === e)?.label ?? e.charAt(0).toUpperCase() + e.slice(1);
}

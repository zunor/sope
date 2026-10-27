// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { FrameScheduler, type FrameClock } from "../src/render/scheduler";

class Clock implements FrameClock {
  time = 0;
  jobs = new Set<{ at: number; run: () => void }>();
  now = () => this.time;
  schedule(run: () => void, delay: number): () => void {
    const job = { at: this.time + delay, run };
    this.jobs.add(job);
    return () => this.jobs.delete(job);
  }
  advance(to: number): void {
    while (true) {
      const job = [...this.jobs].sort((a, b) => a.at - b.at)[0];
      if (!job || job.at > to) break;
      this.time = Math.max(this.time, job.at);
      this.jobs.delete(job);
      job.run();
    }
    this.time = Math.max(this.time, to);
  }
}

test("the default clock schedules a real frame", async () => {
  let rendered = 0;
  const scheduler = new FrameScheduler(() => { rendered++; });
  scheduler.request();
  await Bun.sleep(30);
  scheduler.stop();
  expect(rendered).toBe(1);
});

test("idle input paints promptly; bursts coalesce without restarting the frame deadline", () => {
  const clock = new Clock();
  let position = 0;
  const frames: Array<{ time: number; position: number }> = [];
  const scheduler = new FrameScheduler(() => frames.push({ time: clock.time, position }), undefined, clock);
  position++;
  scheduler.request();
  clock.advance(0);
  expect(frames).toEqual([{ time: 0, position: 1 }]);
  for (const t of [4, 8, 12, 16]) {
    clock.advance(t);
    position++;
    scheduler.request();
  }
  expect(clock.jobs.size).toBe(1);
  clock.advance(17);
  expect(frames).toEqual([{ time: 0, position: 1 }, { time: 17, position: 5 }]);
  clock.advance(1000);
  expect(frames).toHaveLength(2); // stopping the gesture leaves no inertia
  scheduler.request();
  clock.advance(1000);
  expect(frames.at(-1)?.time).toBe(1000); // no fixed input-to-frame delay after idle
});

test("sustained 250 Hz input is painted at most 60 times a second without losing the final position", () => {
  const clock = new Clock();
  let position = 0;
  const frames: Array<{ time: number; position: number }> = [];
  const scheduler = new FrameScheduler(() => frames.push({ time: clock.time, position }), undefined, clock);
  for (let t = 0; t < 1000; t += 4) {
    clock.advance(t);
    position++;
    scheduler.request();
  }
  clock.advance(1020);
  expect(frames.length).toBeGreaterThanOrEqual(58);
  expect(frames.length).toBeLessThanOrEqual(61);
  expect(frames.at(-1)?.position).toBe(250);
  for (let i = 1; i < frames.length; i++) expect(frames[i]!.time - frames[i - 1]!.time).toBeGreaterThanOrEqual(1000 / 60);
});

test("a slow terminal receives the latest reversed position, not a backlog of stale frames", () => {
  const clock = new Clock();
  let ready = true;
  let position = 0;
  const frames: number[] = [];
  const scheduler = new FrameScheduler(() => { frames.push(position); ready = false; }, () => ready, clock);
  scheduler.request();
  clock.advance(0);
  for (let i = 1; i <= 100; i++) { position = i; scheduler.request(); }
  position = 99; // reverse immediately while stdout is still blocked
  scheduler.request();
  clock.advance(1000);
  expect(frames).toEqual([0]);
  expect(clock.jobs.size).toBe(0);
  ready = true;
  scheduler.resume();
  clock.advance(1000);
  expect(frames).toEqual([0, 99]);
  ready = true;
  scheduler.resume();
  clock.advance(2000);
  expect(frames).toEqual([0, 99]); // drain alone is not a redraw
});

test("backpressure arriving after scheduling retains the dirty frame until drain", () => {
  const clock = new Clock();
  let ready = true;
  let rendered = 0;
  const scheduler = new FrameScheduler(() => { rendered++; }, () => ready, clock);
  scheduler.request();
  ready = false;
  clock.advance(20);
  expect(rendered).toBe(0);
  ready = true;
  scheduler.resume();
  clock.advance(20);
  expect(rendered).toBe(1);
});

test("a slow render does not cause catch-up frames, and stop cancels pending work", () => {
  const clock = new Clock();
  const times: number[] = [];
  const scheduler = new FrameScheduler(() => { times.push(clock.time); clock.time += 40; }, undefined, clock);
  scheduler.request();
  clock.advance(0);
  scheduler.request();
  clock.advance(40);
  expect(times).toEqual([0, 40]);
  scheduler.request();
  scheduler.stop();
  scheduler.request();
  scheduler.resume();
  clock.advance(1000);
  expect(times).toEqual([0, 40]);
  expect(clock.jobs.size).toBe(0);
});

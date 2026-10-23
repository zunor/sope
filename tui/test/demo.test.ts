// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { executionPolicy } from "../src/agent/environment";

test("TUI shell policy carries the tool path without inheriting credentials", () => {
  const policy = executionPolicy("openai", {
    PATH: "/custom/bin:/usr/bin:/bin", HOME: "/fixture", LANG: "en_US.UTF-8",
    SOPE_API_KEY: "model-secret", AWS_SECRET_ACCESS_KEY: "cloud-secret", BASH_ENV: "/untrusted",
  });
  expect(policy.environment?.PATH).toContain("/custom/bin:/usr/bin:/bin");
  expect(policy.environment?.HOME).toBe("/fixture");
  expect(policy.environment).not.toHaveProperty("SOPE_API_KEY");
  expect(policy.environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  expect(policy.environment).not.toHaveProperty("BASH_ENV");
  expect(policy.tools).toContain("agent");
  expect(policy.tools).toContain("bash");
});

test("configured demos use GLM 5.3 at the supplied endpoint by default", async () => {
  const models: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const body = await req.json() as { model: string };
      models.push(body.model);
      const chunk = { choices: [{ index: 0, delta: { content: "Live endpoint reached." }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const child = Bun.spawn([process.execPath, "scripts/demo.ts", "tour", "--print"], {
    cwd: resolve(import.meta.dir, "../.."),
    env: { ...process.env, SOPE_API_KEY: "demo-test", SOPE_MODEL: "another-model",
      SOPE_BASE_URL: `http://127.0.0.1:${server.port}/v1`, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
    stdout: "pipe", stderr: "pipe",
  });
  try {
    const [stdout, , code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("Live endpoint reached.");
    expect(models).toEqual(["glm-5.3"]);
  } finally {
    child.kill();
    server.stop(true);
  }
}, 15_000);

for (const [scenario, expected] of [
  ["tour", "No files changed."],
  ["edit", "**4 tests passed.**"],
  ["review", "Two perspectives. One small fix."],
] as const) {
  test(`offline ${scenario} demo completes with real tools`, async () => {
    const child = Bun.spawn([process.execPath, "scripts/demo.ts", scenario, "--offline", "--print"], {
      cwd: resolve(import.meta.dir, "../.."),
      // Reproduce launchers where Bun is executable but missing from PATH.
      env: { ...process.env, PATH: "/usr/bin:/bin" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, error: stderr.includes("command not found") }).toEqual({ code: 0, error: false });
    expect(stdout).toContain(expected);
  }, 15_000);
}

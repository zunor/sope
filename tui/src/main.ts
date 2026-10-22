#!/usr/bin/env bun
import { App } from "./app";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("sope: the TUI needs an interactive terminal");
  process.exit(1);
}

const app = new App();

const crash = (err: unknown) => {
  app.restoreTerminal();
  console.error(err);
  process.exit(1);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);
for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, () => void app.quit());

app.start();

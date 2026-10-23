#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// The sope executable: `sope` opens the TUI, `sope -p` answers without it.
//
// Release builds embed libsope (bun build --compile ... libsope.dylib); the
// embedded copy is used unless SOPE_LIB points elsewhere. In the repo,
// bindings/js finds build/libsope.* on its own.

import { libraryPath, useLibrary, version } from "sope";
import { readImageFile, type ImageFile } from "./agent/images";
import { CliError, parseArgs, USAGE } from "./cli";
import { loadConfig } from "./config";

function embeddedLibrary(): string | undefined {
  const file = Bun.embeddedFiles.find((f) => /^libsope[\w.-]*\.(dylib|so|dll)$/.test((f as Blob & { name: string }).name));
  return file && `${import.meta.dir}/${(file as Blob & { name: string }).name}`;
}

async function readStdin(): Promise<string> {
  return process.stdin.isTTY ? "" : (await Bun.stdin.text()).trim();
}

async function main(): Promise<number> {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    console.error(`sope: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const embedded = embeddedLibrary();
  if (embedded && !process.env.SOPE_LIB) useLibrary(embedded);

  if (opts.version) {
    console.log(`sope ${version()} (${process.platform}-${process.arch}, libsope ${embedded && !process.env.SOPE_LIB ? "embedded" : libraryPath()})`);
    return 0;
  }

  const config = loadConfig({ provider: opts.provider, model: opts.model, baseUrl: opts.baseUrl, permissions: opts.permissions, effort: opts.effort });
  let images: ImageFile[];
  try {
    images = opts.images.map((path) => readImageFile(path));
  } catch (err) {
    console.error(`sope: ${(err as Error).message}`);
    return 2;
  }

  if (opts.print || !process.stdout.isTTY) {
    const prompt = [opts.prompt, await readStdin()].filter(Boolean).join("\n\n");
    if (!prompt) {
      console.error("sope: nothing to do: give a prompt or pipe one in (sope -p \"...\")");
      return 2;
    }
    const { runPrint } = await import("./print");
    return runPrint(config, prompt, images);
  }

  if (!process.stdin.isTTY) {
    console.error("sope: the TUI needs an interactive terminal; use -p to read the prompt from stdin");
    return 2;
  }

  const { App } = await import("./app");
  if (images.length && !opts.prompt) {
    console.error("sope: --image goes with a prompt: sope --image shot.png \"what is wrong here?\"");
    return 2;
  }
  const app = new App({ config, prompt: opts.prompt, images });
  const crash = (err: unknown) => {
    app.restoreTerminal();
    console.error(err);
    process.exit(1);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, () => void app.quit());
  app.start();
  return -1; // the TUI exits on its own
}

const code = await main().catch((err: unknown) => {
  console.error(`sope: ${err instanceof Error ? err.message : String(err)}`);
  return 1;
});
if (code >= 0) process.exit(code);

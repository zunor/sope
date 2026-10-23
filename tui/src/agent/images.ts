// SPDX-License-Identifier: MIT
// Getting images into a message: from the clipboard (ctrl+v), from a file
// dragged into the terminal (which pastes its path), or from --image.
// libsope does the rest (sope_attach_image).

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

export const MAX_IMAGE_BYTES = 10 << 20; // sope_attach_image's limit

export interface ImageFile {
  bytes: Uint8Array;
  mediaType: string;
  /** Where it came from, for the transcript: a file name or "clipboard". */
  label: string;
}

/** The media type by the file's signature, as libsope checks it; null if not a supported image. */
export function imageType(b: Uint8Array): string | null {
  const at = (s: string, off = 0) => [...s].every((c, i) => b[off + i] === c.charCodeAt(0));
  if (b.length >= 8 && b[0] === 0x89 && at("PNG\r\n\x1a\n", 1)) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && (at("GIF87a") || at("GIF89a"))) return "image/gif";
  if (b.length >= 12 && at("RIFF") && at("WEBP", 8)) return "image/webp";
  return null;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** Reads an image file; throws with a readable reason when it is not one. */
export function readImageFile(path: string, cwd = process.cwd()): ImageFile {
  const file = resolve(cwd, path);
  const size = statSync(file).size;
  if (size > MAX_IMAGE_BYTES) throw new Error(`${basename(file)} is ${Math.round(size / 1048576)} MB; images can be at most 10 MB`);
  const bytes = new Uint8Array(readFileSync(file));
  const mediaType = imageType(bytes);
  if (!mediaType) throw new Error(`${basename(file)} is not a PNG, JPEG, GIF or WebP image`);
  return { bytes, mediaType, label: basename(file) };
}

/**
 * The image file a paste names, if it is exactly one: terminals paste a
 * dragged file as its path, quoted or with backslash-escaped spaces.
 */
export function pastedImagePath(text: string, cwd = process.cwd()): string | null {
  let t = text.trim();
  if (!t || t.includes("\n")) return null;
  if (/^(['"]).*\1$/.test(t)) t = t.slice(1, -1);
  else t = t.replace(/\\(.)/g, "$1");
  if (t.startsWith("file://")) t = decodeURIComponent(t.slice(7));
  if (!IMAGE_EXT.test(t)) return null;
  const file = resolve(cwd, t);
  try {
    return existsSync(file) && statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

async function run(cmd: string[]): Promise<Uint8Array | null> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const out = new Uint8Array(await new Response(p.stdout).arrayBuffer());
    return (await p.exited) === 0 ? out : null;
  } catch {
    return null; // the tool is not installed
  }
}

/** The image on the clipboard, or null when there is none (or no way to read it). */
export async function clipboardImage(platform = process.platform): Promise<ImageFile | null> {
  let bytes: Uint8Array | null = null;
  if (platform === "darwin") {
    // AppleScript prints image data as «data PNGf89504E47…»
    const out = await run(["osascript", "-e", "get the clipboard as «class PNGf»"]);
    const hex = out && /«data PNGf([0-9A-Fa-f]+)»/.exec(new TextDecoder().decode(out))?.[1];
    if (hex) bytes = Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
    if (!bytes) {
      // A file copied in Finder: the clipboard holds its path.
      const path = await run(["osascript", "-e", "POSIX path of (the clipboard as «class furl»)"]);
      const p = path && new TextDecoder().decode(path).trim();
      if (p && IMAGE_EXT.test(p)) return readImageFile(p);
    }
  } else {
    bytes = (await run(["wl-paste", "--no-newline", "--type", "image/png"])) ?? (await run(["xclip", "-selection", "clipboard", "-t", "image/png", "-o"]));
  }
  if (!bytes?.length) return null;
  const mediaType = imageType(bytes);
  if (!mediaType) return null;
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("the clipboard image is over 10 MB");
  return { bytes, mediaType, label: "clipboard" };
}

/** "[Image #3]" tokens in a message, in order of appearance, each once. */
export function imageRefs(text: string): number[] {
  return [...new Set([...text.matchAll(/\[Image #(\d+)\]/g)].map((m) => Number(m[1])))];
}

export function describeImage(img: ImageFile): string {
  const kb = Math.max(1, Math.round(img.bytes.length / 1024));
  return `${img.label}, ${img.mediaType.slice(6)}, ${kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`}`;
}

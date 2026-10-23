// SPDX-License-Identifier: MIT
// A small Kitty graphics overlay, enabled only after a successful query.
// https://sw.kovidgoyal.net/kitty/graphics-protocol/

export interface PixelImage {
  /** Stable overlay slot. Zero is reserved for the status meteor. */
  slot?: number;
  /** Negative values put the image below text, above cell backgrounds. */
  z?: number;
  compression?: "zlib";
  x: number;
  y: number;
  columns: number;
  rows: number;
  width: number;
  height: number;
  /** Base64 RGBA, optionally zlib-compressed. */
  data: string;
}

const IMAGE_ID = 0x534f5045;
const command = (keys: string, data = "") => `\x1b_G${keys};${data}\x1b\\`;

export class KittyGraphics {
  supported = false;
  #queried = false;
  #last = new Map<number, PixelImage>();

  query(env: NodeJS.ProcessEnv = process.env): string {
    // Multiplexer passthrough is intentionally outside this initial backend.
    this.#queried = env.SOPE_GRAPHICS !== "0" && !env.TMUX && !env.STY && !env.ZELLIJ && env.TERM !== "dumb";
    this.supported = false;
    return this.#queried ? command(`a=q,i=${IMAGE_ID},t=d,f=32,s=1,v=1`, "AAAAAA==") : "";
  }

  reply(data: string): void {
    if (this.#queried && data === `Gi=${IMAGE_ID};OK`) this.supported = true;
  }

  clear(): string {
    const out = [...this.#last.keys()].map((slot) => this.#delete(slot)).join("");
    this.#last.clear();
    return out;
  }

  #delete(slot: number): string {
    return command(`a=d,d=I,i=${IMAGE_ID + slot},q=2`);
  }

  render(frame: PixelImage | readonly PixelImage[] | null, force = false): string {
    if (!this.supported || !frame) return this.clear();
    const images: readonly PixelImage[] = Array.isArray(frame) ? frame : [frame as PixelImage];
    const next = new Map(images.map((image) => [image.slot ?? 0, image]));
    let out = "";
    for (const slot of this.#last.keys()) if (!next.has(slot)) out += this.#delete(slot);
    for (const [slot, image] of next) {
      const old = this.#last.get(slot);
      if (!force && old && Object.keys(image).length === Object.keys(old).length &&
          Object.keys(image).every((k) => image[k as keyof PixelImage] === old[k as keyof PixelImage])) continue;
      if (old) out += this.#delete(slot);
      out += this.#draw(image, slot);
    }
    this.#last = next;
    return out;
  }

  #draw(image: PixelImage, slot: number): string {
    let out = "";
    out += `\x1b[${image.y + 1};${image.x + 1}H`;
    // Both dimensions constrain the placement; callers needing exact cell
    // alignment render at the reported cell pixel size to avoid letterboxing.
    const keys = `a=T,i=${IMAGE_ID + slot},p=1,t=d,f=32,s=${image.width},v=${image.height},c=${image.columns},r=${image.rows},C=1,q=2,z=${image.z ?? 0}${image.compression ? ",o=z" : ""}`;
    for (let offset = 0; offset < image.data.length; offset += 4096) {
      const chunk = image.data.slice(offset, offset + 4096);
      const more = offset + 4096 < image.data.length ? 1 : 0;
      out += command(`${offset === 0 ? keys + "," : ""}m=${more}`, chunk);
    }
    return out;
  }
}

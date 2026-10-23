// SPDX-License-Identifier: MIT
// A small Kitty graphics overlay, enabled only after a successful query.
// https://sw.kovidgoyal.net/kitty/graphics-protocol/

export interface PixelImage {
  x: number;
  y: number;
  columns: number;
  rows: number;
  width: number;
  height: number;
  /** Base64 raw RGBA. */
  data: string;
}

const IMAGE_ID = 0x534f5045;
const command = (keys: string, data = "") => `\x1b_G${keys};${data}\x1b\\`;

export class KittyGraphics {
  supported = false;
  #queried = false;
  #last: PixelImage | null = null;

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
    if (!this.#last) return "";
    this.#last = null;
    return command(`a=d,d=I,i=${IMAGE_ID},q=2`);
  }

  render(image: PixelImage | null, force = false): string {
    if (!this.supported || !image) return this.clear();
    const old = this.#last;
    if (!force && old && Object.keys(image).every((k) => image[k as keyof PixelImage] === old[k as keyof PixelImage])) return "";
    let out = this.clear();
    out += `\x1b[${image.y + 1};${image.x + 1}H`;
    // Both dimensions constrain the placement to one row; the protocol preserves
    // the square image's aspect ratio using letterboxing when necessary.
    const keys = `a=T,i=${IMAGE_ID},p=1,t=d,f=32,s=${image.width},v=${image.height},c=${image.columns},r=${image.rows},C=1,q=2`;
    for (let offset = 0; offset < image.data.length; offset += 4096) {
      const chunk = image.data.slice(offset, offset + 4096);
      const more = offset + 4096 < image.data.length ? 1 : 0;
      out += command(`${offset === 0 ? keys + "," : ""}m=${more}`, chunk);
    }
    this.#last = image;
    return out;
  }
}

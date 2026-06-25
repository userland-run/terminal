// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Glyph atlas — the Phase-2 perf lever. Each unique glyph (keyed on codepoint +
// bold + italic) is rasterised exactly once via a 2D canvas into a shelf in a
// texture; the GPU renderer then samples those slots. Once the working set
// converges (a few hundred glyphs) no rasterisation happens, so idle cost ≈ 0.
//
// The atlas stores white, anti-aliased coverage in the alpha channel; the
// renderer tints it with the per-cell foreground colour in the fragment shader.

const ATLAS_W = 2048;
const ATLAS_H = 1024;

/** Normalised atlas position of a glyph's top-left corner. */
export interface GlyphSlot {
  u0: number;
  v0: number;
}

export class GlyphAtlas {
  texture!: GPUTexture;
  /** Normalised slot size (du, dv) — same for every glyph. */
  slotU = 0;
  slotV = 0;

  private canvas: OffscreenCanvas | HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private slots = new Map<number, GlyphSlot>();
  private next = 0;
  private cols = 0;
  private capacity = 0;
  private dirty = true;

  // Slot geometry in device px, plus the device-px font size and baseline.
  private slotW = 0;
  private slotH = 0;
  private fontPx = 0;
  private glyphY = 0;

  constructor(private device: GPUDevice, private fontFamily: string) {
    // Branch (rather than a union) so getContext narrows to one return type.
    if (typeof OffscreenCanvas !== "undefined") {
      const oc = new OffscreenCanvas(ATLAS_W, ATLAS_H);
      this.canvas = oc;
      this.ctx = oc.getContext("2d")!;
    } else {
      const hc = document.createElement("canvas");
      hc.width = ATLAS_W;
      hc.height = ATLAS_H;
      this.canvas = hc;
      this.ctx = hc.getContext("2d")!;
    }
    this.ctx.textBaseline = "top";
    this.texture = this.makeTexture();
  }

  /**
   * Set slot geometry (device px) and font size (device px). Invalidates every
   * cached glyph — call on font-size / DPR change only, not per frame.
   */
  configure(slotW: number, slotH: number, fontPx: number) {
    this.slotW = slotW;
    this.slotH = slotH;
    this.fontPx = fontPx;
    this.glyphY = (slotH - fontPx) / 2;
    this.slotU = slotW / ATLAS_W;
    this.slotV = slotH / ATLAS_H;
    this.cols = Math.max(1, Math.floor(ATLAS_W / slotW));
    this.capacity = this.cols * Math.max(1, Math.floor(ATLAS_H / slotH));
    this.slots.clear();
    this.next = 0;
    this.ctx.clearRect(0, 0, ATLAS_W, ATLAS_H);
    this.dirty = true;
  }

  /** Atlas slot for a glyph, rasterising on first use. null if it cannot fit. */
  get(codepoint: number, bold: boolean, italic: boolean): GlyphSlot | null {
    const key = codepoint | (bold ? 1 << 24 : 0) | (italic ? 1 << 25 : 0);
    const hit = this.slots.get(key);
    if (hit) return hit;
    if (this.next >= this.capacity) {
      console.warn("[atlas] full — dropping glyph", codepoint);
      return null;
    }

    const i = this.next++;
    const col = i % this.cols;
    const row = Math.floor(i / this.cols);
    const px = col * this.slotW;
    const py = row * this.slotH;

    const weight = bold ? "700" : "400";
    const style = italic ? "italic " : "";
    this.ctx.font = `${style}${weight} ${this.fontPx}px ${this.fontFamily}`;
    this.ctx.fillStyle = "#fff";
    this.ctx.clearRect(px, py, this.slotW, this.slotH);
    this.ctx.fillText(String.fromCodePoint(codepoint), px, py + this.glyphY);

    const slot: GlyphSlot = { u0: px / ATLAS_W, v0: py / ATLAS_H };
    this.slots.set(key, slot);
    this.dirty = true;
    return slot;
  }

  /** Upload the backing canvas to the GPU texture if glyphs were added. */
  uploadIfDirty(queue: GPUQueue) {
    if (!this.dirty) return;
    queue.copyExternalImageToTexture(
      { source: this.canvas as GPUCopyExternalImageSource },
      { texture: this.texture },
      { width: ATLAS_W, height: ATLAS_H }
    );
    this.dirty = false;
  }

  destroy() {
    this.texture.destroy();
  }

  private makeTexture(): GPUTexture {
    return this.device.createTexture({
      label: "glyph-atlas",
      size: { width: ATLAS_W, height: ATLAS_H },
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }
}

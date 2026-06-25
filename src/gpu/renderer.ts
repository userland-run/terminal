// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

import type { TermSnapshot } from "@container/nanovm.mjs";
import { THEME, THEME_RGB, ansiRgb, hexToRgb, type Rgb } from "../palette";
import type { TermRenderer } from "../renderer";
import type { Selection } from "../selection";
import { ordered } from "../selection";
import { requestGpu } from "./device";
import { GlyphAtlas } from "./atlas";

// Cell flag bits — must match src/term.rs in the nano repo (mirror of renderer.ts).
const FLAG_BOLD = 1 << 0;
const FLAG_DIM = 1 << 1;
const FLAG_ITALIC = 1 << 2;
const FLAG_UNDERLINE = 1 << 3;
const FLAG_INVERSE = 1 << 4;
const FLAG_FG_DEFAULT = 1 << 5;
const FLAG_BG_DEFAULT = 1 << 6;

// Each instance is 8 floats: two vec2 + one vec4.
const FLOATS_PER_INSTANCE = 8;
const INSTANCE_STRIDE = FLOATS_PER_INSTANCE * 4; // bytes

// Shared uniform block (padded to 32 bytes).
const UNIFORMS = /* wgsl */ `
struct U {
  resolution: vec2f,  // canvas size, device px
  cell: vec2f,        // cell size, device px
  atlasSlot: vec2f,   // glyph slot size, normalised
  _pad: vec2f,
};
@group(0) @binding(0) var<uniform> u: U;

// Device-px coordinate -> clip space (y down -> y up).
fn toClip(px: vec2f) -> vec4f {
  return vec4f(px.x / u.resolution.x * 2.0 - 1.0, 1.0 - px.y / u.resolution.y * 2.0, 0.0, 1.0);
}
`;

const RECT_SHADER = UNIFORMS + /* wgsl */ `
struct In {
  @location(0) corner: vec2f,
  @location(1) pos: vec2f,
  @location(2) size: vec2f,
  @location(3) color: vec4f,
};
struct Out { @builtin(position) clip: vec4f, @location(0) color: vec4f };

@vertex fn vs(in: In) -> Out {
  var out: Out;
  out.clip = toClip(in.pos + in.corner * in.size);
  out.color = in.color;
  return out;
}
@fragment fn fs(in: Out) -> @location(0) vec4f { return in.color; }
`;

const GLYPH_SHADER = UNIFORMS + /* wgsl */ `
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var atlas: texture_2d<f32>;

struct In {
  @location(0) corner: vec2f,
  @location(1) cellPos: vec2f,
  @location(2) uv0: vec2f,
  @location(3) color: vec4f,
};
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
};

@vertex fn vs(in: In) -> Out {
  var out: Out;
  out.clip = toClip(in.cellPos + in.corner * u.cell);
  out.uv = in.uv0 + in.corner * u.atlasSlot;
  out.color = in.color;
  return out;
}
@fragment fn fs(in: Out) -> @location(0) vec4f {
  // The atlas stores anti-aliased coverage in alpha; tint with the cell colour.
  let cov = textureSample(atlas, samp, in.uv).a;
  return vec4f(in.color.rgb, in.color.a * cov);
}
`;

const BLEND: GPUBlendState = {
  color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
};

// Selection highlight — the comp's ::selection violet rgba(169,132,245,.32)
// composited over the terminal surface (#15151a).
const SELECTION_RGB = hexToRgb("#443960");

function sameRgb(a: Rgb | null, b: Rgb | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** WebGPU terminal renderer: instanced background rects + a cached glyph atlas. */
export class GpuRenderer implements TermRenderer {
  cellW = 0;
  cellH = 0;

  private dpr = Math.max(1, window.devicePixelRatio || 1);
  private cellWdev = 0;
  private cellHdev = 0;
  private cols = 0;
  private rows = 0;

  private device: GPUDevice;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;
  private atlas: GlyphAtlas;
  private measureCtx: CanvasRenderingContext2D;

  private rectPipeline!: GPURenderPipeline;
  private glyphPipeline!: GPURenderPipeline;
  private rectBind!: GPUBindGroup;
  private glyphBind!: GPUBindGroup;

  private uniformBuf: GPUBuffer;
  private quadBuf: GPUBuffer;
  private rectBuf!: GPUBuffer;
  private glyphBuf!: GPUBuffer;
  private rectData = new Float32Array(0);
  private glyphData = new Float32Array(0);

  private selection: Selection | null = null;

  // Damage tracking: skip the GPU entirely when nothing changed.
  private lastHash = -1;
  private lastCursorOn = false;

  static async create(canvas: HTMLCanvasElement, fontSize = 15): Promise<GpuRenderer> {
    const gpu = await requestGpu(canvas);
    return new GpuRenderer(canvas, gpu.device, gpu.context, gpu.format, fontSize);
  }

  private constructor(
    private canvas: HTMLCanvasElement,
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    private fontSize: number
  ) {
    this.device = device;
    this.context = context;
    this.format = format;
    this.atlas = new GlyphAtlas(device, THEME.font);

    const mc = document.createElement("canvas").getContext("2d");
    if (!mc) throw new Error("2D context unavailable for text metrics");
    this.measureCtx = mc;

    // Static resources.
    this.uniformBuf = device.createBuffer({
      label: "uniforms",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Unit quad as a triangle strip: (0,0) (1,0) (0,1) (1,1).
    this.quadBuf = device.createBuffer({
      label: "quad",
      size: 8 * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.quadBuf, 0, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]));

    this.buildPipelines();
    this.measure();
  }

  // --- pipeline / bind-group construction -----------------------------------

  private buildPipelines() {
    const { device, format } = this;

    const quadLayout: GPUVertexBufferLayout = {
      arrayStride: 8,
      stepMode: "vertex",
      attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
    };
    const instanceLayout: GPUVertexBufferLayout = {
      arrayStride: INSTANCE_STRIDE,
      stepMode: "instance",
      attributes: [
        { shaderLocation: 1, offset: 0, format: "float32x2" },
        { shaderLocation: 2, offset: 8, format: "float32x2" },
        { shaderLocation: 3, offset: 16, format: "float32x4" },
      ],
    };
    const primitive: GPUPrimitiveState = { topology: "triangle-strip" };

    // Rect pipeline: uniforms only.
    const rectBgl = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    });
    const rectMod = device.createShaderModule({ code: RECT_SHADER });
    this.rectPipeline = device.createRenderPipeline({
      label: "rect",
      layout: device.createPipelineLayout({ bindGroupLayouts: [rectBgl] }),
      vertex: { module: rectMod, entryPoint: "vs", buffers: [quadLayout, instanceLayout] },
      fragment: { module: rectMod, entryPoint: "fs", targets: [{ format, blend: BLEND }] },
      primitive,
    });
    this.rectBind = device.createBindGroup({
      layout: rectBgl,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuf } }],
    });

    // Glyph pipeline: uniforms + sampler + atlas texture.
    const glyphBgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });
    const glyphMod = device.createShaderModule({ code: GLYPH_SHADER });
    this.glyphPipeline = device.createRenderPipeline({
      label: "glyph",
      layout: device.createPipelineLayout({ bindGroupLayouts: [glyphBgl] }),
      vertex: { module: glyphMod, entryPoint: "vs", buffers: [quadLayout, instanceLayout] },
      fragment: { module: glyphMod, entryPoint: "fs", targets: [{ format, blend: BLEND }] },
      primitive,
    });
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.glyphBind = device.createBindGroup({
      layout: glyphBgl,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: this.atlas.texture.createView() },
      ],
    });
  }

  // --- sizing ----------------------------------------------------------------

  measure() {
    this.measureCtx.font = `${this.fontSize}px ${THEME.font}`;
    this.cellW = Math.max(1, Math.round(this.measureCtx.measureText("M").width));
    this.cellH = Math.round(this.fontSize * 1.4);
    this.cellWdev = Math.max(1, Math.round(this.cellW * this.dpr));
    this.cellHdev = Math.max(1, Math.round(this.cellH * this.dpr));
    // Glyphs are rasterised at device resolution so they sample 1:1.
    this.atlas.configure(this.cellWdev, this.cellHdev, Math.round(this.fontSize * this.dpr));
    this.lastHash = -1; // atlas cache cleared — force a redraw
    this.updateUniforms();
  }

  setFontSize(px: number) {
    this.fontSize = px;
    this.measure();
  }

  setSelection(sel: Selection | null) {
    this.selection = sel;
    this.lastHash = -1; // force a redraw to paint/clear the highlight
  }

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.canvas.width = cols * this.cellWdev;
    this.canvas.height = rows * this.cellHdev;
    this.canvas.style.width = `${(cols * this.cellWdev) / this.dpr}px`;
    this.canvas.style.height = `${(rows * this.cellHdev) / this.dpr}px`;

    // Worst case: every cell a 1-wide bg run + an underline, one selection rect
    // per row, plus the cursor.
    const rectCap = 2 * cols * rows + rows + 1;
    const glyphCap = cols * rows + 1;
    this.rectData = new Float32Array(rectCap * FLOATS_PER_INSTANCE);
    this.glyphData = new Float32Array(glyphCap * FLOATS_PER_INSTANCE);
    this.rectBuf?.destroy();
    this.glyphBuf?.destroy();
    this.rectBuf = this.device.createBuffer({
      label: "rect-instances",
      size: rectCap * INSTANCE_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.glyphBuf = this.device.createBuffer({
      label: "glyph-instances",
      size: glyphCap * INSTANCE_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.lastHash = -1;
    this.updateUniforms();
  }

  private updateUniforms() {
    this.device.queue.writeBuffer(
      this.uniformBuf,
      0,
      new Float32Array([
        this.canvas.width,
        this.canvas.height,
        this.cellWdev,
        this.cellHdev,
        this.atlas.slotU,
        this.atlas.slotV,
        0,
        0,
      ])
    );
  }

  // --- drawing ---------------------------------------------------------------

  draw(s: TermSnapshot, cursorOn: boolean) {
    if (s.cols !== this.cols || s.rows !== this.rows) this.resize(s.cols, s.rows);

    const hash = this.hash(s);
    if (hash === this.lastHash && cursorOn === this.lastCursorOn) return; // idle: skip GPU
    this.lastHash = hash;
    this.lastCursorOn = cursorOn;

    const { rectCount, glyphCount } = this.buildInstances(s, cursorOn);

    const q = this.device.queue;
    this.atlas.uploadIfDirty(q);
    if (rectCount) q.writeBuffer(this.rectBuf, 0, this.rectData, 0, rectCount * FLOATS_PER_INSTANCE);
    if (glyphCount)
      q.writeBuffer(this.glyphBuf, 0, this.glyphData, 0, glyphCount * FLOATS_PER_INSTANCE);

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: THEME_RGB.bg[0], g: THEME_RGB.bg[1], b: THEME_RGB.bg[2], a: 1 },
        },
      ],
    });
    pass.setVertexBuffer(0, this.quadBuf);
    if (rectCount) {
      pass.setPipeline(this.rectPipeline);
      pass.setBindGroup(0, this.rectBind);
      pass.setVertexBuffer(1, this.rectBuf);
      pass.draw(4, rectCount);
    }
    if (glyphCount) {
      pass.setPipeline(this.glyphPipeline);
      pass.setBindGroup(0, this.glyphBind);
      pass.setVertexBuffer(1, this.glyphBuf);
      pass.draw(4, glyphCount);
    }
    pass.end();
    q.submit([enc.finish()]);
  }

  /** Build background/underline/cursor rects and glyph quads for one frame. */
  private buildInstances(s: TermSnapshot, cursorOn: boolean): { rectCount: number; glyphCount: number } {
    const dv = new DataView(s.cells.buffer, s.cells.byteOffset, s.cells.byteLength);
    const cells = s.cells;
    const { cellWdev, cellHdev, cols, rows } = this;
    const rect = this.rectData;
    const glyph = this.glyphData;
    let ri = 0;
    let gi = 0;
    const underline = Math.max(1, Math.round(this.dpr));
    const showCursor = cursorOn && s.cursorRow < rows && s.cursorCol < cols;

    for (let r = 0; r < rows; r++) {
      const y = r * cellHdev;
      // Background: coalesce horizontal runs of identical colour into one rect.
      let runRgb: Rgb | null = null;
      let runStart = -1;
      for (let c = 0; c < cols; c++) {
        const bg = this.cellBg(dv, cells, r * cols + c);
        if (!sameRgb(bg, runRgb)) {
          if (runRgb && runStart >= 0) {
            ri = pushRect(rect, ri, runStart * cellWdev, y, (c - runStart) * cellWdev, cellHdev, runRgb, 1);
          }
          runRgb = bg;
          runStart = bg ? c : -1;
        }
      }
      if (runRgb && runStart >= 0) {
        ri = pushRect(rect, ri, runStart * cellWdev, y, (cols - runStart) * cellWdev, cellHdev, runRgb, 1);
      }

      // Glyphs + underline.
      for (let c = 0; c < cols; c++) {
        if (showCursor && r === s.cursorRow && c === s.cursorCol) continue; // drawn below
        const o = (r * cols + c) * 8;
        const ch = dv.getUint32(o, true);
        const flags = cells[o + 6];
        const fg = this.cellFg(cells, o, flags);
        const x = c * cellWdev;
        if (ch && ch !== 0x20) {
          const slot = this.atlas.get(ch, !!(flags & FLAG_BOLD), !!(flags & FLAG_ITALIC));
          if (slot) gi = pushGlyph(glyph, gi, x, y, slot.u0, slot.v0, fg, flags & FLAG_DIM ? 0.6 : 1);
        }
        if (flags & FLAG_UNDERLINE) {
          ri = pushRect(rect, ri, x, y + cellHdev - underline, cellWdev, underline, fg, 1);
        }
      }
    }

    // Selection highlight — one rect per selected row, drawn over the
    // background and under the glyphs (so selected text stays readable).
    if (this.selection) {
      const { start, end } = ordered(this.selection);
      for (let row = Math.max(0, start.row); row <= Math.min(rows - 1, end.row); row++) {
        const cStart = row === start.row ? start.col : 0;
        const cEnd = row === end.row ? end.col : cols - 1;
        ri = pushRect(
          rect,
          ri,
          cStart * cellWdev,
          row * cellHdev,
          (cEnd - cStart + 1) * cellWdev,
          cellHdev,
          SELECTION_RGB,
          1
        );
      }
    }

    // Inverted violet block cursor, drawn last.
    if (showCursor) {
      const x = s.cursorCol * cellWdev;
      const y = s.cursorRow * cellHdev;
      ri = pushRect(rect, ri, x, y, cellWdev, cellHdev, THEME_RGB.cursor, 1);
      const o = (s.cursorRow * cols + s.cursorCol) * 8;
      const ch = dv.getUint32(o, true);
      if (ch && ch !== 0x20) {
        const flags = cells[o + 6];
        const slot = this.atlas.get(ch, !!(flags & FLAG_BOLD), !!(flags & FLAG_ITALIC));
        if (slot) gi = pushGlyph(glyph, gi, x, y, slot.u0, slot.v0, THEME_RGB.bg, 1);
      }
    }

    return { rectCount: ri / FLOATS_PER_INSTANCE, glyphCount: gi / FLOATS_PER_INSTANCE };
  }

  /** Effective background colour of a cell, or null for the ground colour. */
  private cellBg(dv: DataView, cells: Uint8Array, idx: number): Rgb | null {
    const o = idx * 8;
    const flags = cells[o + 6];
    if (flags & FLAG_INVERSE) {
      // Inverse: the foreground becomes the background (always a colour).
      return flags & FLAG_FG_DEFAULT ? THEME_RGB.fg : ansiRgb(cells[o + 4]);
    }
    return flags & FLAG_BG_DEFAULT ? null : ansiRgb(cells[o + 5]);
  }

  /** Effective foreground (glyph) colour of a cell. */
  private cellFg(cells: Uint8Array, o: number, flags: number): Rgb {
    if (flags & FLAG_INVERSE) {
      // Inverse: old background (or ground) becomes the foreground.
      return flags & FLAG_BG_DEFAULT ? THEME_RGB.bg : ansiRgb(cells[o + 5]);
    }
    return flags & FLAG_FG_DEFAULT ? THEME_RGB.fg : ansiRgb(cells[o + 4]);
  }

  /** FNV-1a over the cell bytes + cursor position — cheap damage signature. */
  private hash(s: TermSnapshot): number {
    let h = 0x811c9dc5;
    const cells = s.cells;
    for (let i = 0; i < cells.length; i++) {
      h ^= cells[i];
      h = Math.imul(h, 0x01000193);
    }
    h = Math.imul(h ^ s.cursorRow, 0x01000193);
    h = Math.imul(h ^ s.cursorCol, 0x01000193);
    return h >>> 0;
  }

  destroy() {
    this.rectBuf?.destroy();
    this.glyphBuf?.destroy();
    this.uniformBuf.destroy();
    this.quadBuf.destroy();
    this.atlas.destroy();
  }
}

function pushRect(
  a: Float32Array,
  o: number,
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: Rgb,
  alpha: number
): number {
  a[o] = x; a[o + 1] = y; a[o + 2] = w; a[o + 3] = h;
  a[o + 4] = rgb[0]; a[o + 5] = rgb[1]; a[o + 6] = rgb[2]; a[o + 7] = alpha;
  return o + FLOATS_PER_INSTANCE;
}

function pushGlyph(
  a: Float32Array,
  o: number,
  x: number,
  y: number,
  u0: number,
  v0: number,
  rgb: Rgb,
  alpha: number
): number {
  a[o] = x; a[o + 1] = y; a[o + 2] = u0; a[o + 3] = v0;
  a[o + 4] = rgb[0]; a[o + 5] = rgb[1]; a[o + 6] = rgb[2]; a[o + 7] = alpha;
  return o + FLOATS_PER_INSTANCE;
}

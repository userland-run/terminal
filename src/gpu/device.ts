// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// Minimal WebGPU bring-up: request an adapter/device and configure the canvas
// context. Throws a descriptive error when WebGPU is unavailable so callers can
// fall back to the 2D-canvas renderer.

export interface Gpu {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}

export async function requestGpu(canvas: HTMLCanvasElement): Promise<Gpu> {
  if (!navigator.gpu) throw new Error("WebGPU not available (navigator.gpu missing)");

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
  if (!adapter) throw new Error("WebGPU: no adapter");

  const device = await adapter.requestDevice();
  // Surface a lost device by throwing on the next frame rather than silently
  // rendering nothing.
  device.lost.then((info) => {
    console.error(`[gpu] device lost: ${info.reason} — ${info.message}`);
  });

  const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!context) throw new Error("WebGPU: canvas.getContext('webgpu') returned null");

  const format = navigator.gpu.getPreferredCanvasFormat();
  // `opaque` — we always clear to the ground colour, so no page compositing of
  // the canvas alpha is needed.
  context.configure({ device, format, alphaMode: "opaque" });

  return { device, context, format };
}

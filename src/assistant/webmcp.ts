// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-UEL
// Copyright (C) 2026 And The Next GmbH - https://userland.run
// Part of the userland.run terminal; dual-licensed - see LICENSE.md.

// WebMCP: expose the same VM tool registry to Chrome's built-in agent via the
// SDK's adapter (`exposeWebMcp` from @userland-run/nano-sdk/agent), so the
// in-page Prompt-API session and Chrome's agent drive the identical tools.
// Origin-trial / flag-gated, so it silently no-ops when the API is absent.
// `approve` gates mutating calls (the panel's mode + approval card). Returns an
// unregister to call on teardown.

import { exposeWebMcp, type AgentApprove } from "@sdk/agent";
import type { AssistantTool } from "./types";

export function registerWebMcpTools(tools: AssistantTool[], approve?: AgentApprove): () => void {
  return exposeWebMcp(tools, { approve });
}

/** Shared agent-host connection config for the plain-fetch API clients, the non-streaming counterpart of the runtime's own config from the same VITE var. */

import type { AgentHostConfig } from "./client.js";

const BASE_URL = (import.meta.env.VITE_AGENT_HOST_URL ?? "").replace(/\/$/, "");

export const agentHostConfig: AgentHostConfig = { baseUrl: BASE_URL };

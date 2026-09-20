// Exa provider: MCP/JSON-RPC transport over fetch plus result shaping.
// Depends on lib/types.js (types), lib/filter.js (domain match),
// lib/policy.js (signals, errors, formatting).
import { isRecord } from "./types.js";
import type {
  McpRpcResponse,
  McpToolResult,
  ExaStructuredResult,
  NormalizedSearchParams,
  ProviderSearchResult,
} from "./types.js";
import { isDomainMatch } from "./filter.js";
import { PACKAGE_VERSION } from "./version.js";
import { getRequestSignal, errorMessage, shortErrorMessage } from "./policy.js";
import { formatNumberedResults } from "./format.js";

export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

// Exa MCP wire constants. Kept as local (non-exported) values so the module
// surface stays the pure builders below; the SPEC pins the literals.
export type ExaToolName = "web_search_exa" | "web_search_advanced_exa";
const EXA_PRIMARY_TOOL: ExaToolName = "web_search_exa";
const EXA_ADVANCED_TOOL: ExaToolName = "web_search_advanced_exa";
const EXA_INITIALIZE_ID = 1;
const EXA_TOOLS_CALL_ID = 2;
const EXA_PROTOCOL_VERSION = "2025-03-26";
const EXA_CLIENT_NAME = "pi-web-search";
const EXA_CLIENT_VERSION = PACKAGE_VERSION;
const EXA_TEXT_MAX_CHARACTERS = 1_000;

/** Build the JSON-RPC `initialize` request body (id 1). Pure. */
export function buildExaInitializeRequest(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: EXA_INITIALIZE_ID,
    method: "initialize",
    params: {
      protocolVersion: EXA_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: EXA_CLIENT_NAME,
        version: EXA_CLIENT_VERSION,
      },
    },
  };
}

/**
 * Build the JSON-RPC `tools/call` request body (id 2). Pure.
 *
 * The advanced tool is selected by name: when called with
 * `web_search_advanced_exa` the domain filters and `textMaxCharacters` are
 * included, matching the server-side authority described in the SPEC.
 */
export function buildExaSearchRequest(
  params: NormalizedSearchParams,
  toolName: ExaToolName,
): Record<string, unknown> {
  const useAdvancedTool = toolName === EXA_ADVANCED_TOOL;
  const argumentsPayload: Record<string, unknown> = {
    query: params.query,
    numResults: params.numResults,
  };
  if (useAdvancedTool) {
    if (params.allowedDomains.length > 0) {
      argumentsPayload.includeDomains = params.allowedDomains;
    }
    if (params.blockedDomains.length > 0) {
      argumentsPayload.excludeDomains = params.blockedDomains;
    }
    argumentsPayload.textMaxCharacters = EXA_TEXT_MAX_CHARACTERS;
  }
  return {
    jsonrpc: "2.0",
    id: EXA_TOOLS_CALL_ID,
    method: "tools/call",
    params: {
      name: toolName,
      arguments: argumentsPayload,
    },
  };
}

export function isExaQuotaOrRateLimitError(error: unknown): boolean {
  return /quota|rate.?limit|too many requests|http\s*429|usage limit|exceeded/iu.test(
    errorMessage(error),
  );
}

export function createExaSearchError(error: unknown): Error {
  const detail = shortErrorMessage(error);
  // Warn-and-try per design: anonymous use may work, so only hint at the
  // key when the server actually rejected auth.
  if (/http\s*40[13]/iu.test(detail)) {
    return new Error(
      `Exa web search is unavailable (${detail}). Set EXA_API_KEY to use Exa, or call web_search_ddg for this search instead; do not retry web_search_exa immediately.`,
    );
  }
  const reason = isExaQuotaOrRateLimitError(error)
    ? "Exa quota or rate limit was reached"
    : "Exa web search is unavailable";
  return new Error(
    `${reason} (${detail}). Call web_search_ddg for this search instead; do not retry web_search_exa immediately.`,
  );
}

export function parseSsePayload(body: string): unknown {
  const blocks = body.split(/\r?\n\r?\n/u);
  const candidates: string[] = [];

  for (const block of blocks) {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /u, ""))
      .join("\n")
      .trim();

    if (data) candidates.push(data);
  }

  for (const candidate of candidates.reverse()) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Ignore non-JSON SSE events and continue looking for the JSON-RPC event.
    }
  }

  throw new Error("Exa MCP returned an invalid SSE response");
}

export function parseMcpResponse(
  body: string,
  contentType: string | null = null,
): McpRpcResponse {
  const trimmed = body.trim();
  if (!trimmed) return {};

  const looksSSE =
    /text\/event-stream/iu.test(contentType ?? "") ||
    /^(event|data):/mu.test(trimmed);

  let payload: unknown;
  if (!looksSSE) {
    try {
      payload = JSON.parse(trimmed) as unknown;
    } catch (jsonError) {
      try {
        payload = parseSsePayload(trimmed);
      } catch {
        throw new Error(
          `Exa MCP response parsed neither as JSON (as JSON: ${shortErrorMessage(jsonError)}) nor as SSE fallback`,
        );
      }
    }
  } else {
    try {
      payload = parseSsePayload(trimmed);
    } catch (sseError) {
      try {
        payload = JSON.parse(trimmed) as unknown;
      } catch {
        throw new Error(
          `Exa MCP response parsed neither as SSE (as SSE: ${shortErrorMessage(sseError)}) nor as JSON fallback`,
        );
      }
    }
  }
  if (!isRecord(payload)) {
    throw new Error("Exa MCP returned an invalid JSON-RPC response");
  }
  return payload as McpRpcResponse;
}

export async function postMcpRequest(
  url: string,
  payload: Record<string, unknown>,
  sessionId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ response: McpRpcResponse; sessionId?: string }> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "x-exa-source": "pi-web-search",
  };
  const apiKey = process.env.EXA_API_KEY?.trim();
  if (apiKey) headers["x-api-key"] = apiKey;
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
    headers["MCP-Protocol-Version"] = EXA_PROTOCOL_VERSION;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: getRequestSignal(signal),
  });
  const body = await response.text();

  if (!response.ok) {
    const suffix = body.trim() ? `: ${body.trim().slice(0, 300)}` : "";
    throw new Error(`Exa MCP returned HTTP ${response.status}${suffix}`);
  }

  return {
    response: parseMcpResponse(body, response.headers.get("content-type")),
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
  };
}

export function mcpError(response: McpRpcResponse): Error | undefined {
  if (!response.error) return undefined;
  const code =
    response.error.code === undefined ? "" : ` (${response.error.code})`;
  return new Error(
    `Exa MCP error${code}: ${response.error.message ?? "unknown error"}`,
  );
}

export function textFromMcpResult(result: McpToolResult): string {
  const text = (result.content ?? [])
    .filter((item) => item.type === undefined || item.type === "text")
    .map((item) => item.text)
    .filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    )
    .join("\n\n")
    .trim();

  if (text) return text;
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  return "";
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof record[key] === "string" && record[key]
    ? record[key]
    : undefined;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
}

function compactText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export function parseExaStructuredResults(
  rawText: string,
): ExaStructuredResult[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.results)) return undefined;

  return parsed.results.flatMap((item): ExaStructuredResult[] => {
    if (!isRecord(item)) return [];

    const url = readString(item, "url");
    if (!url) return [];

    const highlights = readStringArray(item, "highlights");
    const snippet = compactText(
      readString(item, "summary") ??
        (highlights.length > 0 ? highlights.join(" ") : undefined) ??
        readString(item, "text") ??
        "",
    );

    return [
      {
        title: compactText(readString(item, "title") ?? url),
        url,
        snippet,
      },
    ];
  });
}

export function formatExaSearchResult(
  toolResult: McpToolResult,
  params: NormalizedSearchParams,
): ProviderSearchResult {
  if (toolResult.isError) {
    throw new Error(textFromMcpResult(toolResult) || "Exa MCP search failed");
  }

  const rawText = textFromMcpResult(toolResult);
  const structuredResults = parseExaStructuredResults(rawText);

  if (structuredResults) {
    const filteredResults = structuredResults
      .filter((result) => !isDomainMatch(result.url, params.blockedDomains))
      .filter(
        (result) =>
          params.allowedDomains.length === 0 ||
          isDomainMatch(result.url, params.allowedDomains),
      )
      .slice(0, params.numResults);

    return {
      text: formatNumberedResults("Exa", filteredResults),
      resultCount: filteredResults.length,
    };
  }

  // Unstructured text cannot be counted reliably; report 0 rather than
  // guessing from body content (a snippet line starting with "Title:"
  // would inflate a /^Title:/ heuristic).
  return {
    text: rawText
      ? `Web search results (provider: Exa):\n\n${rawText}`
      : "No web search results found (provider: Exa).",
    resultCount: 0,
  };
}

export async function searchExa(
  params: NormalizedSearchParams,
  signal: AbortSignal | undefined,
): Promise<ProviderSearchResult> {
  const useAdvancedTool =
    params.allowedDomains.length > 0 || params.blockedDomains.length > 0;
  const toolName = useAdvancedTool ? EXA_ADVANCED_TOOL : EXA_PRIMARY_TOOL;
  const endpoint = new URL(EXA_MCP_URL);
  endpoint.searchParams.set("tools", toolName);

  const initialized = await postMcpRequest(
    endpoint.toString(),
    buildExaInitializeRequest(),
    undefined,
    signal,
  );
  const initializeError = mcpError(initialized.response);
  if (initializeError) throw initializeError;

  const sessionId = initialized.sessionId;
  await postMcpRequest(
    endpoint.toString(),
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
    sessionId,
    signal,
  );

  const called = await postMcpRequest(
    endpoint.toString(),
    buildExaSearchRequest(params, toolName),
    sessionId,
    signal,
  );
  const callError = mcpError(called.response);
  if (callError) throw callError;
  if (!called.response.result) {
    throw new Error("Exa MCP returned no tool result");
  }

  return formatExaSearchResult(called.response.result, params);
}

export async function searchExaForTool(
  params: NormalizedSearchParams,
  signal: AbortSignal | undefined,
): Promise<ProviderSearchResult> {
  try {
    return await searchExa(params, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw createExaSearchError(error);
  }
}

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createExaSessionStore, searchExa } from "../lib/exa.js";
import type { NormalizedSearchParams } from "../lib/types.js";

// These tests exercise the MCP session lifecycle without a network: the Exa
// transport is `fetch`, so we replace globalThis.fetch with a scripted server
// and count the JSON-RPC methods it sees.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const base: NormalizedSearchParams = {
  query: "hello",
  allowedDomains: [],
  blockedDomains: [],
  numResults: 3,
};

function jsonResponse(
  payload: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function initializeResponse(sessionId?: string): Response {
  return jsonResponse(
    { jsonrpc: "2.0", id: 1, result: {} },
    sessionId ? { "mcp-session-id": sessionId } : {},
  );
}

function searchResponse(): Response {
  return jsonResponse({
    jsonrpc: "2.0",
    id: 2,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results: [
              { title: "A", url: "https://a.example.com", text: "snippet" },
            ],
          }),
        },
      ],
    },
  });
}

type Body = { method?: string };

/** Replace fetch with a handler that receives the parsed JSON-RPC body. */
function installFetch(handler: (body: Body) => Response): void {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    return handler(body);
  }) as typeof fetch;
}

describe("Exa MCP session reuse", () => {
  it("handshakes once and reuses the session for later searches", async () => {
    const methods: string[] = [];
    installFetch((body) => {
      methods.push(body.method ?? "unknown");
      if (body.method === "initialize") return initializeResponse("sess-1");
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return searchResponse();
    });

    const sessions = createExaSessionStore();
    await searchExa(base, undefined, sessions);
    await searchExa(base, undefined, sessions);

    assert.deepEqual(methods, [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
  });

  it("keys sessions by the full endpoint, so advanced and primary differ", async () => {
    let initializes = 0;
    installFetch((body) => {
      if (body.method === "initialize") {
        initializes += 1;
        return initializeResponse(`sess-${initializes}`);
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return searchResponse();
    });

    const sessions = createExaSessionStore();
    const primary = { ...base, allowedDomains: [] };
    const advanced = { ...base, allowedDomains: ["a.com"] };
    await searchExa(primary, undefined, sessions);
    await searchExa(advanced, undefined, sessions);
    await searchExa(primary, undefined, sessions);
    await searchExa(advanced, undefined, sessions);

    assert.equal(initializes, 2);
  });

  it("re-handshakes once and retries when a cached session has expired", async () => {
    let initializes = 0;
    let toolCalls = 0;
    installFetch((body) => {
      if (body.method === "initialize") {
        initializes += 1;
        return initializeResponse(`sess-${initializes}`);
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      toolCalls += 1;
      if (toolCalls === 2) {
        return new Response("stale session", { status: 404 });
      }
      return searchResponse();
    });

    const sessions = createExaSessionStore();
    await searchExa(base, undefined, sessions);
    const out = await searchExa(base, undefined, sessions);

    assert.equal(out.resultCount, 1);
    assert.equal(initializes, 2);
    assert.equal(toolCalls, 3);
  });

  it("does not retry a non-404 failure even with a cached session", async () => {
    let initializes = 0;
    let toolCalls = 0;
    installFetch((body) => {
      if (body.method === "initialize") {
        initializes += 1;
        return initializeResponse(`sess-${initializes}`);
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      toolCalls += 1;
      if (toolCalls === 2) {
        return new Response("server error", { status: 500 });
      }
      return searchResponse();
    });

    const sessions = createExaSessionStore();
    await searchExa(base, undefined, sessions);
    await assert.rejects(searchExa(base, undefined, sessions), /HTTP 500/);

    assert.equal(initializes, 1);
    assert.equal(toolCalls, 2);
  });

  it("does not retry a JSON-RPC error even with a cached session", async () => {
    let initializes = 0;
    let toolCalls = 0;
    installFetch((body) => {
      if (body.method === "initialize") {
        initializes += 1;
        return initializeResponse(`sess-${initializes}`);
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      toolCalls += 1;
      if (toolCalls === 2) {
        return jsonResponse({
          jsonrpc: "2.0",
          id: 2,
          error: { code: -32602, message: "invalid params" },
        });
      }
      return searchResponse();
    });

    const sessions = createExaSessionStore();
    await searchExa(base, undefined, sessions);
    await assert.rejects(searchExa(base, undefined, sessions), /Exa MCP error/);

    assert.equal(initializes, 1);
    assert.equal(toolCalls, 2);
  });

  it("does not cache a session whose notifications/initialized fails", async () => {
    let initializes = 0;
    installFetch((body) => {
      if (body.method === "initialize") {
        initializes += 1;
        return initializeResponse(`sess-${initializes}`);
      }
      if (body.method === "notifications/initialized") {
        return jsonResponse({
          jsonrpc: "2.0",
          error: { code: -32600, message: "bad notification" },
        });
      }
      return searchResponse();
    });

    const sessions = createExaSessionStore();
    await assert.rejects(searchExa(base, undefined, sessions), /Exa MCP error/);
    // A half-finished handshake must not be reused, so the next search starts
    // a fresh one instead of trusting the id from the failed handshake.
    await assert.rejects(searchExa(base, undefined, sessions), /Exa MCP error/);
    assert.equal(initializes, 2);
  });

  it("does not cache a server that issues no session id", async () => {
    const methods: string[] = [];
    installFetch((body) => {
      methods.push(body.method ?? "unknown");
      if (body.method === "initialize") return initializeResponse();
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return searchResponse();
    });

    const sessions = createExaSessionStore();
    await searchExa(base, undefined, sessions);
    await searchExa(base, undefined, sessions);

    assert.equal(methods.filter((method) => method === "initialize").length, 2);
  });

  it("does not re-handshake when the caller aborted the failed call", async () => {
    let initializes = 0;
    let toolCalls = 0;
    const controller = new AbortController();
    installFetch((body) => {
      if (body.method === "initialize") {
        initializes += 1;
        return initializeResponse("sess-1");
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      toolCalls += 1;
      if (toolCalls === 1) return searchResponse();
      controller.abort();
      return new Response("gone", { status: 500 });
    });

    const sessions = createExaSessionStore();
    await searchExa(base, undefined, sessions);
    await assert.rejects(searchExa(base, controller.signal, sessions));

    assert.equal(initializes, 1);
    assert.equal(toolCalls, 2);
  });
});

describe("Exa MCP request deadline", () => {
  it("shares one signal across every round trip of a search", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      signals.push(init?.signal);
      const body = JSON.parse(String(init?.body ?? "{}")) as Body;
      if (body.method === "initialize") return initializeResponse("sess-1");
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return searchResponse();
    }) as typeof fetch;

    await searchExa(base, undefined, createExaSessionStore());

    // initialize + notifications/initialized + tools/call must all be bounded
    // by the same deadline signal, not one fresh timeout per round trip.
    assert.equal(signals.length, 3);
    assert.ok(signals[0] instanceof AbortSignal);
    assert.equal(signals[0], signals[1]);
    assert.equal(signals[1], signals[2]);
  });
});

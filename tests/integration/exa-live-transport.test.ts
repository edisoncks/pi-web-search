import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  createExaSessionStore,
  EXA_MCP_URL_ENV,
  searchExa,
} from "../../lib/exa.js";
import type { NormalizedSearchParams } from "../../lib/types.js";

// A real HTTP server speaking the MCP JSON-RPC/SSE shapes drives `searchExa`
// end to end: handshake, session-header round trip, tools/call, and the
// cached-session 404 re-handshake. No external network.

interface ServerState {
  initializeCount: number;
  sessionCounter: number;
  issued: string[];
  invalidSessions: Set<string>;
  lastHeaders: { apiKey?: string; session?: string };
}

const state: ServerState = {
  initializeCount: 0,
  sessionCounter: 0,
  issued: [],
  invalidSessions: new Set(),
  lastHeaders: {},
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendSse(
  response: ServerResponse,
  payloads: unknown[],
  headers: Record<string, string> = {},
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    ...headers,
  });
  response.end(payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join(""));
}

const structuredResults = JSON.stringify({
  results: [{ title: "A", url: "https://example.com/a", text: "s" }],
});

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const message = JSON.parse(await readBody(request)) as { method?: string };
  state.lastHeaders = {
    apiKey: request.headers["x-api-key"] as string | undefined,
    session: request.headers["mcp-session-id"] as string | undefined,
  };

  if (message.method === "initialize") {
    state.initializeCount += 1;
    const session = `sess-${(state.sessionCounter += 1)}`;
    state.issued.push(session);
    // A leading notification must not win over the final JSON-RPC result.
    sendSse(
      response,
      [
        {
          jsonrpc: "2.0",
          method: "notifications/message",
          params: { level: "info", data: "starting" },
        },
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } },
      ],
      { "mcp-session-id": session },
    );
    return;
  }

  if (message.method === "notifications/initialized") {
    response.writeHead(202);
    response.end();
    return;
  }

  if (message.method === "tools/call") {
    const session = state.lastHeaders.session;
    if (session !== undefined && state.invalidSessions.has(session)) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("unknown session");
      return;
    }
    sendSse(response, [
      {
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: structuredResults }] },
      },
    ]);
    return;
  }

  response.writeHead(400);
  response.end();
}

const server = createServer((request, response) => {
  handle(request, response).catch(() => {
    response.writeHead(500);
    response.end();
  });
});

const params: NormalizedSearchParams = {
  query: "hello",
  allowedDomains: [],
  blockedDomains: [],
  numResults: 5,
};

const savedUrl = process.env[EXA_MCP_URL_ENV];
const savedKey = process.env.EXA_API_KEY;
let base = "";

before(async () => {
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  base = `http://127.0.0.1:${address.port}/mcp`;
});

beforeEach(() => {
  state.initializeCount = 0;
  state.sessionCounter = 0;
  state.issued = [];
  state.invalidSessions = new Set();
  state.lastHeaders = {};
  delete process.env.EXA_API_KEY;
  process.env[EXA_MCP_URL_ENV] = base;
});

after(async () => {
  // `fetch` pools keep-alive sockets; close them before waiting on `close()`.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (savedUrl === undefined) delete process.env[EXA_MCP_URL_ENV];
  else process.env[EXA_MCP_URL_ENV] = savedUrl;
  if (savedKey === undefined) delete process.env.EXA_API_KEY;
  else process.env.EXA_API_KEY = savedKey;
});

describe("Exa live transport over a real socket", () => {
  it("runs the handshake and a search end to end", async () => {
    const result = await searchExa(params, undefined, createExaSessionStore());
    assert.equal(result.resultCount, 1);
    assert.match(result.text, /example\.com\/a/);
    assert.equal(state.initializeCount, 1);
  });

  it("re-handshakes and retries once when a cached session is expired", async () => {
    const sessions = createExaSessionStore();

    const first = await searchExa(params, undefined, sessions);
    assert.equal(first.resultCount, 1);
    assert.equal(state.initializeCount, 1);

    // Expire the session the first search cached, then search again.
    state.invalidSessions.add(state.issued[0]!);
    const second = await searchExa(params, undefined, sessions);

    assert.equal(second.resultCount, 1);
    assert.equal(state.initializeCount, 2);
  });

  it("forwards EXA_API_KEY as the x-api-key header", async () => {
    process.env.EXA_API_KEY = "test-key";
    await searchExa(params, undefined, createExaSessionStore());
    assert.equal(state.lastHeaders.apiKey, "test-key");
  });
});

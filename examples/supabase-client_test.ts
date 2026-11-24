import {
  createOpenBspClient,
  readConfig,
  recentIncoming,
} from "./supabase-client.ts";

const config = {
  url: "https://openbsp.example.test",
  anonKey: "example-anon-key",
  apiKey: "example-openbsp-key",
  organizationId: "00000000-0000-0000-0000-000000000001",
};

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("reads messages with API-key auth and a bounded incoming query", async () => {
  const rows = [{
    id: "message-1",
    timestamp: "2026-01-01T00:00:00Z",
    conversation_address: "15550000001",
    sender_address: "15550000001",
    content: { version: "1", type: "text", kind: "text", text: "Hello" },
  }];
  let requests = 0;
  const client = createOpenBspClient(config, (input, init) => {
    requests++;
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    equal(init?.method, "GET");
    equal(url.origin, config.url);
    equal(url.pathname, "/rest/v1/messages");
    equal(headers.get("apikey"), config.anonKey);
    equal(headers.get("api-key"), config.apiKey);
    equal(headers.get("authorization"), `Bearer ${config.anonKey}`);
    equal(
      url.searchParams.get("organization_id"),
      `eq.${config.organizationId}`,
    );
    equal(url.searchParams.get("service"), "eq.whatsapp");
    equal(url.searchParams.get("sender_address"), "not.is.null");
    equal(url.searchParams.get("order"), "timestamp.desc");
    equal(url.searchParams.get("limit"), "20");
    equal(
      url.searchParams.get("select"),
      "id,timestamp,conversation_address,sender_address,content",
    );
    return Promise.resolve(Response.json(rows));
  });

  equal(await recentIncoming(client, config.organizationId), rows);
  equal(requests, 1);
});

Deno.test("an empty inbox returns an empty array", async () => {
  const client = createOpenBspClient(
    config,
    () => Promise.resolve(Response.json([])),
  );
  equal(await recentIncoming(client, config.organizationId), []);
});

Deno.test("a PostgREST error is not reported as an empty inbox", async () => {
  const client = createOpenBspClient(
    config,
    () =>
      Promise.resolve(Response.json({
        code: "42501",
        message: "permission denied for table messages",
        details: null,
        hint: null,
      }, { status: 403 })),
  );
  try {
    await recentIncoming(client, config.organizationId);
    throw new Error("Expected the request to fail");
  } catch (error) {
    equal(
      (error as Error).message,
      "Could not read messages: permission denied for table messages",
    );
  }
});

Deno.test("requires every environment variable without exposing its values", () => {
  const values: Record<string, string> = {
    SUPABASE_URL: config.url,
    SUPABASE_ANON_KEY: config.anonKey,
    OPENBSP_API_KEY: config.apiKey,
    OPENBSP_ORGANIZATION_ID: config.organizationId,
  };
  equal(readConfig((name) => values[name]), config);
  for (const missing of Object.keys(values)) {
    try {
      readConfig((name) => name === missing ? " " : values[name]);
      throw new Error("Expected missing configuration to fail");
    } catch (error) {
      equal(
        (error as Error).message,
        `Set ${missing} before running this example`,
      );
    }
  }
});

import {
  createOpenBspClient,
  readConfig,
  recentIncoming,
} from "./supabase-client.ts";

const config = {
  url: "https://openbsp.example.test",
  publishableKey: "sb_publishable_example",
  apiKey: "example-openbsp-key",
};

const organizationId = "00000000-0000-0000-0000-000000000001";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function rejects(promise: Promise<unknown>, message: string) {
  try {
    await promise;
  } catch (error) {
    equal((error as Error).message, message);
    return;
  }
  throw new Error(`Expected "${message}"`);
}

// Answers each table with its rows, or with a response when given one.
function server(
  tables: Record<string, unknown[] | Response>,
  seen: string[] = [],
) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    equal(init?.method, "GET");
    equal(url.origin, config.url);
    equal(headers.get("apikey"), config.publishableKey);
    equal(headers.get("api-key"), config.apiKey);
    equal(headers.get("authorization"), `Bearer ${config.publishableKey}`);

    const table = url.pathname.replace("/rest/v1/", "");
    seen.push(`${table}?${url.searchParams}`);
    const answer = tables[table];
    if (!answer) throw new Error(`Unexpected request to ${url.pathname}`);
    return Promise.resolve(
      answer instanceof Response ? answer : Response.json(answer),
    );
  };
}

Deno.test("reads the key's organization, then its latest incoming messages", async () => {
  const rows = [{
    id: "message-1",
    timestamp: "2026-01-01T00:00:00Z",
    conversation_address: "15550000001",
    sender_address: "15550000001",
    content: { version: "1", type: "text", kind: "text", text: "Hello" },
  }];
  const seen: string[] = [];
  const client = createOpenBspClient(
    config,
    server({ organizations: [{ id: organizationId }], messages: rows }, seen),
  );

  equal(await recentIncoming(client), rows);

  const messages = new URLSearchParams(seen[1].split("?")[1]);
  equal(seen.length, 2);
  equal(seen[0], "organizations?select=id");
  equal(messages.get("organization_id"), `eq.${organizationId}`);
  equal(messages.get("service"), "eq.whatsapp");
  equal(messages.get("sender_address"), "not.is.null");
  equal(messages.get("order"), "timestamp.desc");
  equal(messages.get("limit"), "20");
  equal(
    messages.get("select"),
    "id,timestamp,conversation_address,sender_address,content",
  );
});

Deno.test("an empty inbox returns an empty array", async () => {
  const client = createOpenBspClient(
    config,
    server({ organizations: [{ id: organizationId }], messages: [] }),
  );
  equal(await recentIncoming(client), []);
});

Deno.test("an unknown key is reported, not read as an empty inbox", async () => {
  const seen: string[] = [];
  const client = createOpenBspClient(
    config,
    server({ organizations: [], messages: [] }, seen),
  );
  await rejects(
    recentIncoming(client),
    "The OpenBSP API key matches no organization on this deployment",
  );
  equal(seen, ["organizations?select=id"]);
});

Deno.test("a PostgREST error is not reported as an empty inbox", async () => {
  const client = createOpenBspClient(
    config,
    server({
      organizations: [{ id: organizationId }],
      messages: Response.json({
        code: "42501",
        message: "permission denied for table messages",
        details: null,
        hint: null,
      }, { status: 403 }),
    }),
  );
  await rejects(
    recentIncoming(client),
    "Could not read messages: permission denied for table messages",
  );
});

Deno.test("requires every environment variable without exposing its values", () => {
  const values: Record<string, string> = {
    SUPABASE_URL: config.url,
    SUPABASE_PUBLISHABLE_KEY: config.publishableKey,
    OPENBSP_API_KEY: config.apiKey,
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

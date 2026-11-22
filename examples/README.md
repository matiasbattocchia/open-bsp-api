# Supabase JS client example

The [Quickstart](../README.md#quickstart) shows how to send a message. This
server-side Deno example reads the 20 most recent incoming WhatsApp messages in
one organization, newest first. It only makes a GET request; it does not send
messages or mark them as read.

## Before running

Connect a WhatsApp account and create an OpenBSP API key in your dashboard, as
described in the Quickstart. Use a key for the organization you want to read.
Install [Deno](https://docs.deno.com/runtime/getting_started/installation/).

Set these environment variables in your server environment or secret manager:

| Variable                  | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| `SUPABASE_URL`            | Your OpenBSP Supabase project URL                      |
| `SUPABASE_ANON_KEY`       | The project's public **anon JWT** key                  |
| `OPENBSP_API_KEY`         | Your secret, organization-scoped OpenBSP API key       |
| `OPENBSP_ORGANIZATION_ID` | Your organization UUID, available in the dashboard URL |

This example uses the legacy anon JWT, not a service-role key. The SDK sends it
as both `apikey` and `Authorization: Bearer ...`, and sends the OpenBSP key
separately as `api-key`. Do not replace the Authorization token with your
OpenBSP key. See [Authentication](../AUTH.md) for the REST header model.

Keep the OpenBSP key on your server, never in browser code, a committed file, or
logs. Session persistence and refresh are disabled because this example uses an
API key, not a signed-in user's session.

## Run

Starting at the repository root, with the variables already set:

```bash
cd examples
deno run --allow-env=SUPABASE_URL,SUPABASE_ANON_KEY,OPENBSP_API_KEY,OPENBSP_ORGANIZATION_ID --allow-net supabase-client.ts
```

The first run downloads the pinned Supabase JS dependency. Successful output is
a JSON array of message IDs, timestamps, addresses, and content. The output can
contain personal data, so do not send it to shared logs.

The query filters `service = whatsapp` and `sender_address IS NOT NULL` (contact
authorship), then orders by `timestamp` descending. It is a single snapshot, not
polling or a subscription. An empty array means no matching rows were visible to
the key. Row-level security still controls access; the explicit organization
filter does not grant access to another organization.

With a per-account `callback_url` override, messages go directly to your app
rather than this table. See
[Integrating](../INTEGRATING.md#7-receive-messages-and-send).

A missing variable or a failed API request exits with status 1. For auth errors,
check that both keys belong to the same deployment and that the OpenBSP key is
valid. No database error is silently converted to an empty inbox.

## Test without an account

From `examples/`:

```bash
deno test supabase-client_test.ts
deno lint
deno check supabase-client.ts supabase-client_test.ts
```

The tests use the real SDK with a fake HTTP response. They check headers, query
filters, successful and empty results, API errors, and missing configuration.
They do not contact OpenBSP or test a deployed database's RLS policies.

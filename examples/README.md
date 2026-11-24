# Supabase JS client example

The [Quickstart](../README.md#quickstart) shows how to send a message. This
server-side Deno example reads the 20 most recent incoming WhatsApp messages of
the organization its API key belongs to, newest first. It only makes GET
requests; it does not send messages or mark them as read.

## Before running

Connect a WhatsApp account and create an OpenBSP API key in your dashboard, as
described in the Quickstart. Install
[Deno](https://docs.deno.com/runtime/getting_started/installation/).

Set these environment variables in your server environment or secret manager:

| Variable                   | Value                                            |
| -------------------------- | ------------------------------------------------ |
| `SUPABASE_URL`             | Your OpenBSP Supabase project URL                |
| `SUPABASE_PUBLISHABLE_KEY` | The project's publishable key (`sb_publishable`) |
| `OPENBSP_API_KEY`          | Your secret, organization-scoped OpenBSP API key |

The SDK sends the publishable key as `apikey` and `Authorization: Bearer ...`,
and the OpenBSP key separately as `api-key`. Do not replace the Authorization
token with your OpenBSP key. The legacy anon JWT works in place of the
publishable key. See [Authentication](../AUTH.md) for the REST header model.

Keep the OpenBSP key on your server, never in browser code, a committed file, or
logs. Session persistence and refresh are disabled because this example uses an
API key, not a signed-in user's session.

## Run

Starting at the repository root, with the variables already set:

```bash
cd examples
deno run --allow-env=SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY,OPENBSP_API_KEY --allow-net supabase-client.ts
```

Successful output is a JSON array of message IDs, timestamps, addresses, and
content. The output can contain personal data, so do not send it to shared logs.

The example first reads the organization the key belongs to. A key the
deployment doesn't know is not refused: row-level security hides every row from
it. Reading its organization first turns that into an error instead of an empty
inbox.

It then filters `service = whatsapp` and `sender_address IS NOT NULL` (contact
authorship), and orders by `timestamp` descending. It is a single snapshot, not
polling or a subscription. An empty array means the organization has no incoming
WhatsApp messages.

With a per-account `callback_url` override, messages go directly to your app
rather than this table. See
[Integrating](../INTEGRATING.md#7-receive-messages-and-send).

A missing variable, an unknown key or a failed API request exits with status 1.

## Kept in step with the API

The example types its queries with the API's generated types
(`supabase/functions/_shared/db_types.ts`) and takes supabase-js from the edge
functions' import map, so CI checks it against the current schema and client.
Copied out of this repository, it needs types of its own
(`supabase gen types typescript`) or none: drop the `Database` parameter.

## Test without an account

From `examples/`, as CI does:

```bash
deno lint && deno check *.ts && deno test
```

The tests use the real SDK with a fake HTTP server. They check headers, query
filters, successful and empty results, an unknown key, API errors, and missing
configuration. They do not contact OpenBSP or test a deployed database's RLS
policies.

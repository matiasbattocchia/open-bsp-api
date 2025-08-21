# Open BSP API

An application built with [Deno 🦕](https://deno.land), powered by Postgres 🐘 and running on [Supabase ⚡](https://supabase.com) for scalable, modern backend infrastructure.

## Deployment

Connect the Supabase CLI to your Supabase account by logging in with your personal access token.
https://supabase.com/dashboard/account/tokens

## Local development

```
npm install -g supabase
```

### Database

```
npx supabase start
```

Run the following query from the SQL Editor.

```
select vault.create_secret(
  'http://supabase_kong_api:8000/functions/v1',
  'edge_functions_url',
  'Public URL'
);

select vault.create_secret(
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU', 'edge_functions_token',
  'Service role key'
);
```

### Edge Functions

```
npx supabase functions serve
```

## Architecture

<img src="./architecture.png" alt="Architecture diagram" width="600">

The system uses a reactive, function-based architecture:

1. A request from the WhatsApp API is received by the `whatsapp-webhook` function.
2. `whatsapp-webhook` processes the incoming message and stores it in the `messages` table.
3. An insert trigger on the `messages` table forwards the message to the `agent-client` function (incoming trigger).
4. `agent-client` builds the conversation context and sends a request to an agent API using the [Chat Completions](https://platform.openai.com/docs/api-reference/chat) format.
5. `agent-client` waits for the agent's response and saves it back to the `messages` table.
6. An outgoing trigger on the `messages` table forwards the new message to the `whatsapp-dispatcher` function.
7. `whatsapp-dispatcher` processes the message and sends a request to the WhatsApp API to deliver it.

This event-driven flow ensures that each component is decoupled and scalable, making it easy to extend or modify individual steps in the pipeline.

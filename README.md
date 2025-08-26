# Open BSP API

An application built with [Deno 🦕](https://deno.land), powered by Postgres 🐘 and running on [Supabase ⚡](https://supabase.com) for scalable, modern backend infrastructure.

## Deployment

1. Create a Supabase project.
2. Configure the following secrets and variables for GitHub Actions in your repository settings.

#### Secrets

- `SUPABASE_ACCESS_TOKEN`: a [personal access token](https://supabase.com/dashboard/account/tokens).
- `SUPABASE_DB_PASSWORD`

#### Variables

- `SUPABASE_PROJECT_ID`

## Local development

Requires Node and Docker.

### Database

```
npx supabase start
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

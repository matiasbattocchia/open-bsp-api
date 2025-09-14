# Open BSP API

The Open Business Service Provider API is built with [Deno 🦕](https://deno.land), powered by Postgres 🐘 and runs on [Supabase ⚡](https://supabase.com) for scalable, modern backend infrastructure.

## Description

Open BSP API is a multi-tenant platform that connects to the official WhatsApp API to receive and send messages, storing them in a Supabase-backed database. Each organization (tenant) manages its own contacts and accesses the API using an individual API key, enabling simple integration with other services and systems.

The architecture is based on webhooks for receiving messages and conversations, and uses the Supabase client for reading and writing data. The API is designed to be simple and easy to integrate, supporting automation and custom workflows.

Optionally, the platform can include the `agent-client` module, which allows you to create lightweight agents or connect to external, more advanced agents using different protocols like `a2a` and `chat-completions`. Lightweight agents can use built-in tools such as:

- MCP client
- SQL client
- HTTP client
- Calculator
- Transfer to human agent

Additionally, `annotator` module that can interpret and extract information from media and document files, including:

- Audio
- Images
- Video
- PDF
- Other text-based documents (CSV, HTML, TXT, etc.)

The `mcp` module utilizes an MCP server to provide agentic access to the API. For instance, you can send messages directly from clients like Claude Desktop or other agent platforms. In addition, most built-in tools—such as SQL, HTTP, and calculator—are also made available through the MCP server.

## Roadmap

The roadmap includes support for new protocols:

- `responses` (OpenAI)
- `messages` (Anthropic)
- `generation` (Google)

Two more tools:

- Calendar (date calculator)
- Code execution (E2B)

An improved annotator (more/different providers por document type)
and more types:

- DOC
- XLS

## Deployment

1. Create a Supabase project.
2. [Fork me](https://github.com/matiasbattocchia/open-bsp-api/fork).
3. Configure the following secrets and variables for GitHub Actions in your repository settings.
4. Re-run the _Release_ action.

#### Secrets

- `SUPABASE_ACCESS_TOKEN`: a [personal access token](https://supabase.com/dashboard/account/tokens).
- `SUPABASE_DB_PASSWORD`
- `SUPABASE_SERVICE_ROLE_KEY`: Get it from `supabase.com/dashboard/project/{project_id}/settings/api-keys`.

#### Variables

- `SUPABASE_PROJECT_ID`: the `{project_id}` in `supabase.com/dashboard/project/{project_id}`.

## WhatsApp Integration

To connect your WhatsApp API to your Supabase project, you'll need to configure the following Edge Functions secrets. Add these at `supabase.com/dashboard/project/{project_id}/functions/secrets`:

| Secret                          | Description                                       |
| ------------------------------- | ------------------------------------------------- |
| `WHATSAPP_VERIFY_TOKEN`         | Custom verification token for webhook validation  |
| `META_APP_ID`                   | Your Meta app's unique identifier                 |
| `META_APP_SECRET`               | Your Meta app's secret key                        |
| `META_SYSTEM_USER_ID`           | System user ID for business management            |
| `META_SYSTEM_USER_ACCESS_TOKEN` | Access token with business management permissions |

Follow these steps to obtain the required credentials:

### Step 1: Create Meta app (skip if you already have one)

1. Navigate to [Facebook Developers](https://developers.facebook.com/apps)
2. Click **Create App**
3. Select the following options:
   - **Use case**: Other
   - **App type**: Business
4. Add **WhatsApp** as a product to your app

### Step 2: Configure WhatsApp webhook

1. Go to `https://developers.facebook.com/apps/{app_id}/whatsapp-business/wa-settings`
2. Set the **callback URL** to: `https://{project_id}.supabase.co/functions/v1/whatsapp-webhook`
3. Create and note your **verify token** → This becomes `WHATSAPP_VERIFY_TOKEN`

### Step 3: Get app credentials

1. Navigate to `https://developers.facebook.com/apps/{app_id}`
2. Go to **App settings** > **Basic**
3. Copy the following values:
   - **App ID** → `META_APP_ID`
   - **App secret** → `META_APP_SECRET`

### Step 4: Create system user

1. Go to `https://business.facebook.com/latest/settings/system_users?business_id={business_id}`
2. Add an **admin system user**
3. Assign your app to the user with **full control** permissions
4. Generate a token with these permissions:
   - `business_management`
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
5. Copy the **User ID** → `META_SYSTEM_USER_ID`
6. Copy the **Access Token** → `META_SYSTEM_USER_ACCESS_TOKEN`

> **Note**: For detailed instructions on system user setup, refer to the [WhatsApp Business Management API documentation](https://developers.facebook.com/docs/whatsapp/business-management-api/get-started).

## Local development

Requires Node 🐢 and Docker 🐋.

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

In the image, green boxes are external services, red are Edge Functions and blue, database tables.
White boxes, clients, connect to the API via one of the Supabase [client libraries](https://supabase.com/docs/guides/api/rest/client-libs).

The system uses a reactive, function-based architecture:

1. A request from the WhatsApp API is received by the `whatsapp-webhook` function.
2. `whatsapp-webhook` processes the incoming message and stores it in the `messages` table.
3. An insert trigger on the `messages` table forwards the message to the `agent-client` function (incoming trigger).
4. `agent-client` builds the conversation context and sends a request to an agent API using the [Chat Completions](https://platform.openai.com/docs/api-reference/chat) format.
5. `agent-client` waits for the agent's response and saves it back to the `messages` table.
6. An outgoing trigger on the `messages` table forwards the new message to the `whatsapp-dispatcher` function.
7. `whatsapp-dispatcher` processes the message and sends a request to the WhatsApp API to deliver it.

This event-driven flow ensures that each component is decoupled and scalable.

### Edge Functions

#### WhatsApp

- `whatsapp-webhook`: Handles incoming webhook events from the [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api).
- `whatsapp-dispatcher`: Sends outbound messages to the WhatsApp Cloud API.
- `whatsapp-manager`: Integrates with the [WhatsApp Business Management API](https://developers.facebook.com/docs/whatsapp/business-management-api) for business and phone number management.

#### Agent

- `agent-client`: Orchestrates agent interactions, builds conversation context, and communicates with external agent APIs.

### Database models

- **users**: Registered user in the application.
- **organizations**: Tenant entity; holds organization metadata.
- **organizations_addresses**: Organization's addresses per service; belongs to an `organization`.
- **contacts**: People associated with an `organization` (address book).
- **conversations**: Conversation between an organization_address and a contact_address for a service; belongs to an `organization`, optionally to a `contact`.
- **messages**: Messages within a `conversation` context; carries direction, type, payload, status, and timestamps.
- **agents**: Human or AI agents for an `organization`; optionally linked to an auth `user`.
- **api_keys**: API access keys scoped to an `organization`.
- **webhooks**: Outbound webhook subscriptions per `organization`.

## Configuration

### Organizations

```ts
export type OrganizationExtra = {
  response_delay_seconds?: number; // default: 3
  welcome_message?: string;
  authorized_contacts_only?: boolean;
  default_agent_id?: string;
  annotations?: {
    mode?: "active" | "inactive";
    model?: "gemini-2.5-pro" | "gemini-2.5-flash"; // default: gemini-2.5-flash
    api_key: string; // default GOOGLE_API_KEY env var
    language?: string;
    extra_prompt?: string;
  };
  error_messages_direction?: "internal" | "outgoing";
};
```

### Agents

```ts
export type AgentExtra = {
  mode?: "active" | "draft" | "inactive";
  description?: string;
  api_url?: "openai" | "anthropic" | "google" | "groq" | string; // default: openai
  api_key?: string; // default: provider env var, i.e. OPENAI_API_KEY
  model?: string; // default: gpt-5-mini
  // TODO: Add responses (openai), messages (anthropic), generate-content (google).
  protocol?: "chat_completions" | "a2a"; // default: chat_completions
  assistant_id?: string;
  max_messages?: number;
  temperature?: number;
  max_tokens?: number;
  thinking?: "minimal" | "low" | "medium" | "high";
  instructions?: string;
  send_inline_files_up_to_size_mb?: number;
  tools?: ToolConfig[];
};
```

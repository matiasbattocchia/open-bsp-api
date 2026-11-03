/**
 * Curated API reference for the OpenBSP query tool.
 *
 * Registered as MCP resource `openbsp://api-reference`.
 * Source: openapi.json definitions + PostgREST docs + Edge Function endpoints.
 */

export const API_REFERENCE = `# OpenBSP API Reference

## PostgREST Query Syntax

All \`/rest/v1/\` endpoints use [PostgREST](https://postgrest.org) syntax.

### Filtering

| Operator | Example | Meaning |
|----------|---------|---------|
| eq | \`?name=eq.John\` | equals |
| neq | \`?status=neq.active\` | not equals |
| gt, gte, lt, lte | \`?created_at=gt.2025-01-01\` | comparisons |
| like | \`?name=like.*john*\` | SQL LIKE (case-sensitive) |
| ilike | \`?name=ilike.*john*\` | SQL ILIKE (case-insensitive) |
| in | \`?status=in.(active,pending)\` | in set |
| is | \`?extra=is.null\` | is null / is not null |

### Selecting columns

\`?select=name,address\` — only return these columns.

### Embedding relations (joins)

\`?select=*,messages(id,content,sender_address)\` — embed related table via FK, with column selection.

### Ordering

\`?order=created_at.desc\` — sort descending.
\`?order=name.asc,created_at.desc\` — multi-column sort.

### Pagination

\`?limit=10&offset=20\` — limit and offset.
Or use the \`Range\` header: \`Range: 0-9\` (first 10 rows).

### Insert (POST)

\`POST /rest/v1/messages\` with JSON body. Add \`Prefer: return=representation\` header to get the created row back.

### Update (PATCH)

\`PATCH /rest/v1/conversations?id=eq.<uuid>\` with JSON body of fields to update. Always include filter to avoid updating all rows. Add \`Prefer: return=representation\` to get updated rows.

### Delete (DELETE)

\`DELETE /rest/v1/conversations?id=eq.<uuid>\`. Always include filter.

### Counting

Add header \`Prefer: count=exact\` to get a total count in the response Content-Range header.

### Single row

Add header \`Accept: application/vnd.pgrst.object+json\` to get a single object instead of an array (404 if not found).

---

## Table Schemas

All tables are scoped by \`organization_id\` via Row Level Security (RLS).

**Services** (the \`service\` enum): whatsapp (Cloud API), whatsapp-web, instagram, tiktok, slack, local (the team's internal chat); discord and teams are reserved.
Addresses are the service's own ids: a phone number or a group JID (\`…@g.us\`) on whatsapp-web; a phone number on whatsapp (whose account address is Meta's phone number ID); an Instagram-scoped user id; TikTok's ids; Slack team, user and channel ids.

### organizations
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default: gen_random_uuid() |
| name | text | required |
| extra | jsonb | org settings (media_preprocessing, error_messages_direction) |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

### contacts_addresses
| Column | Type | Notes |
|--------|------|-------|
| organization_id | uuid | PK, FK → organizations.id |
| organization_address | text | PK, FK → organizations_addresses (the connection whose address book this entry belongs to) |
| service | service | PK |
| address | text | PK (the contact's address on the service) |
| extra | jsonb | display name lives here: extra.synced.name (saved address-book name) or extra.name (the contact's own push name or profile name); extra.username on instagram/tiktok |
| status | text | default: active |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

### conversations
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default: gen_random_uuid() |
| organization_id | uuid | FK → organizations.id |
| service | service | |
| organization_address | text | the account that holds it |
| address | text | the peer: individual or group/channel address |
| name | text | group/channel name |
| type | text | direct, group, channel, broadcast |
| extra | jsonb | |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

### messages
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default: gen_random_uuid() |
| organization_id | uuid | FK → organizations.id |
| conversation_id | uuid | FK → conversations.id |
| service | service | |
| organization_address | text | |
| content | jsonb | message content (see content structure below) |
| status | jsonb | delivery status |
| agent_id | uuid | FK → agents.id |
| external_id | text | provider message ID |
| conversation_address | text | the peer: individual or group/channel address |
| sender_address | text | the contact who authored it (ties to contacts_addresses); null = the account itself spoke (sends, echoes, internal) |
| thread_id | text | Slack thread: the root message's external_id; null = main timeline |
| timestamp | timestamptz | default: now() |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

**Message content structure:**
\`\`\`json
{
  "version": "1",
  "type": "text",
  "kind": "text",
  "text": "Hello!"
}
\`\`\`

Types: text, file, data. Kinds vary by type (text: text/caption; file: audio/image/video/document/sticker; data: location/contacts/reaction/share/poll/template/media_placeholder/unsupported).
\`content.internal: true\` marks a record-only row (AI tool traces, errors): never dispatched, not part of the conversation.

**Text limits:** an outgoing text (or caption) longer than its service sends is refused at insert — whatsapp 4096 (caption 1024), instagram 1000, tiktok 6000, slack 40000, whatsapp-web 65536 characters. \`POST /rest/v1/rpc/text_limit\` with \`{"service": "...", "type": "text"|"file"}\` returns it. Split longer texts into several messages.

### organizations_addresses
| Column | Type | Notes |
|--------|------|-------|
| organization_id | uuid | PK, FK → organizations.id |
| service | service | PK |
| address | text | PK (the account's id on the service) |
| agent_id | uuid | owner of a personal account; null = the org's shared inbox |
| extra | jsonb | whatsapp: phone_number, verified_name, waba_id; instagram/tiktok: username, name; slack: team_name |
| status | text | connected, disconnected |
| issue | jsonb | what the service broke ({reason, until?, detail?}), null while it works |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

### agents
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default: gen_random_uuid() |
| organization_id | uuid | FK → organizations.id |
| user_id | uuid | FK → auth.users; null = an AI agent |
| name | text | required |
| role | role | owner, admin, member (default: member) |
| extra | jsonb | AI config (model, api_url, instructions, tools, etc.) |
| picture | text | |
| deleted_at | timestamptz | set when the agent left; null = active |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

### webhooks
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default: gen_random_uuid() |
| organization_id | uuid | FK → organizations.id |
| table_name | webhook_table | messages, conversations, organizations_addresses, contacts_addresses, logs |
| operations | webhook_operation[] | INSERT, UPDATE, DELETE |
| url | varchar | |
| token | varchar | |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

### invitations
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default: gen_random_uuid() |
| organization_id | uuid | FK → organizations.id |
| email | text | required; the invitation key |
| role | role | default: member |
| status | text | pending, accepted, rejected, revoked |
| invited_by | uuid | FK → agents.id |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

### api_keys
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, default: gen_random_uuid() |
| organization_id | uuid | FK → organizations.id |
| name | text | required |
| key | text | required |
| role | role | default: member |
| created_at | timestamptz | default: now() |
| updated_at | timestamptz | default: now() |

---

## RPC Functions

| Path | Description |
|------|-------------|
| /rest/v1/rpc/get_authorized_orgs | Get organizations the current user has access to |
| /rest/v1/rpc/accept_invitation | Accept an invitation (body: {"invitation_id": "<uuid>"}); returns the agent id |
| /rest/v1/rpc/reject_invitation | Reject an invitation (body: {"invitation_id": "<uuid>"}) |
| /rest/v1/rpc/text_limit | Longest text a service sends (body: {"service": "whatsapp", "type": "text"}); null = no limit |

---

## Edge Function Endpoints

### WhatsApp Management

Template routes take a JSON body \`{"organization_id": "<uuid>", "organization_address": "<phone number ID>", "template"?: {...}}\`. A disconnected account answers 409.

| Path | Method | Description |
|------|--------|-------------|
| /functions/v1/whatsapp-management/templates | PUT | List templates; with \`template: {"id": "..."}\`, fetch that one |
| /functions/v1/whatsapp-management/templates | POST | Create a template |
| /functions/v1/whatsapp-management/templates | PATCH | Edit a template |
| /functions/v1/whatsapp-management/templates | DELETE | Delete a template |

Connecting accounts runs in the \`setup\` tool's menus (WhatsApp Business, Instagram and TikTok through an onboarding link, WhatsApp Web through a pairing code) or in the OpenBSP app (Slack too).

---

## Example Queries

**List the organization's accounts, every service:**
\`GET /rest/v1/organizations_addresses?select=service,address,status,issue,extra&order=service.asc\`

**List contacts (first 10):**
\`GET /rest/v1/contacts_addresses?select=address,extra,status&limit=10&order=address.asc\`

**Search contacts by name:** (name lives in extra — saved address-book name or push name)
\`GET /rest/v1/contacts_addresses?or=(extra->synced->>name.ilike.*john*,extra->>name.ilike.*john*)&select=address,extra\`

**Recent conversations:**
\`GET /rest/v1/conversations?select=id,service,address,name,type,updated_at&order=updated_at.desc&limit=10\`

**Recent Instagram conversations:**
\`GET /rest/v1/conversations?service=eq.instagram&select=id,address,name,updated_at&order=updated_at.desc&limit=10\`

**Messages in a conversation:**
\`GET /rest/v1/messages?conversation_id=eq.<uuid>&select=id,sender_address,content,timestamp&order=timestamp.asc\`

**Recent incoming messages:** (authored by a contact, i.e. sender_address set)
\`GET /rest/v1/messages?sender_address=not.is.null&select=id,service,conversation_id,sender_address,content,timestamp&order=timestamp.desc&limit=20\`

**List AI agents:** (an agent with no user is an AI agent)
\`GET /rest/v1/agents?user_id=is.null&deleted_at=is.null&select=id,name,extra\`

**Create a contact address:**
\`POST /rest/v1/contacts_addresses\` with body \`{"organization_id": "<uuid>", "organization_address": "<org_phone_number_id>", "service": "whatsapp", "address": "<contact_phone>", "extra": {"name": "John Doe"}}\` and header \`Prefer: return=representation\`

**Send a message (via insert):** the conversation's service, organization_address and address say where it goes — any service.
\`POST /rest/v1/messages\` with body:
\`\`\`json
{
  "organization_id": "<uuid>",
  "service": "instagram",
  "organization_address": "<account address>",
  "conversation_address": "<conversation address>",
  "content": {"version": "1", "type": "text", "kind": "text", "text": "Hello!"}
}
\`\`\`
A WhatsApp conversation takes free-form text only within 24h of the contact's last message; past that, send a template (\`"type": "data", "kind": "template"\`).
Note: The \`reply\` tool is easier: it takes a conversation_id and fills in the rest.
`;

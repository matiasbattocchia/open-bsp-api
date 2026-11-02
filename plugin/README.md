# OpenBSP Plugin for Claude Code

An [MCP plugin](https://code.claude.com/docs/en/plugins) that gives Claude Code
full access to the OpenBSP platform — query any API endpoint, manage contacts,
conversations, templates, and more. Bridges incoming messages from every service
the organization is connected to (WhatsApp, WhatsApp Web, Instagram, TikTok,
Slack) into your session in real-time via Supabase Realtime.

## How it works

```
┌─────────────────────────────────────────────────────────┐
│  Claude Code                                            │
│    ├─ login tool ──► Google OAuth → Supabase session    │
│    ├─ query tool ──► PostgREST / Edge Functions (API)   │
│    ├─ reply tool ──► messages table → service dispatch  │
│    └─ channel ◄──── Supabase Realtime (org's inbox)     │
└─────────────────────────────────────────────────────────┘
```

1. **Sign-in (on demand):** The `login` tool runs the Google OAuth flow. It
   opens your browser and shows the sign-in link in a Claude Code dialog (MCP
   elicitation) — nothing pops up unprompted at startup. Sessions persist and
   refresh automatically.
2. **API access:** The `query` tool makes authenticated HTTP requests to
   PostgREST and Edge Functions. Claude reads the `openbsp://api-reference`
   resource for schema and syntax, then queries freely.
3. **Channel:** Once signed in to an organization, the plugin subscribes to
   Supabase Realtime. Incoming messages, on any service, appear as `<channel>`
   notifications. Claude replies using the `reply` tool, in the conversation the
   message came from.

If the user belongs to no organization, the plugin runs in **API-only mode** —
`query` works, `reply` is not listed.

## Prerequisites

- [Deno](https://deno.com) v2+
- [Claude Code](https://claude.com/claude-code) v2.1.80+
- An OpenBSP user account (Google SSO)

## Quick start

**Hosted users (zero config):** Production Supabase credentials are built in.
Just authenticate with Google and go.

```bash
claude --plugin-dir ./plugin
```

Sign in with `/openbsp:config login` — or just start using the plugin and Claude
will prompt you to sign in when needed. After that, sessions are refreshed
automatically.

**Self-hosted users:** Point to your own Supabase instance:

```
/openbsp:config configure https://your-project.supabase.co your-anon-key
```

## API access

The `query` tool lets Claude make any authenticated API call. Before the first
query, Claude reads the `openbsp://api-reference` resource which contains table
schemas, PostgREST syntax, and example queries.

### Example queries

```
# Connected accounts, every service
query: GET /rest/v1/organizations_addresses?select=service,address,status,extra

# Search contacts by name
query: GET /rest/v1/contacts_addresses?extra->>name=ilike.*john*&select=service,address,extra

# Recent conversations
query: GET /rest/v1/conversations?select=id,service,address,name,updated_at&order=updated_at.desc&limit=10

# Messages in a conversation (sender_address null = sent by the organization)
query: GET /rest/v1/messages?conversation_id=eq.<uuid>&select=id,sender_address,content,timestamp&order=timestamp.asc

# List WhatsApp templates
query: PUT /functions/v1/whatsapp-management/templates
       body: {"organization_id": "<uuid>", "organization_address": "<phone number ID>"}
```

Security: paths must start with `/rest/v1/` or `/functions/v1/`. Auth headers
are injected automatically.

## Channel

Once signed in, the plugin subscribes to Realtime and forwards the messages
contacts write to Claude — on every account the organization has connected,
whatever the service.

### Add contacts (required for channel)

The channel is **secure by default** — no contacts are allowed until explicitly
added. All messages from unknown contacts are silently dropped. This does not
affect API access (RLS governs that).

An entry is an address on any service: a phone number (WhatsApp, WhatsApp Web),
an Instagram or TikTok user id, a Slack user id, or a conversation's own address
— a WhatsApp group JID, a Slack channel id. A message is forwarded when its
author or its conversation is allowed. Phone numbers match on their digits;
other addresses verbatim.

```
/openbsp:config contacts add 5491155551234          # a WhatsApp contact
/openbsp:config contacts add 17841400000000000      # an Instagram user
/openbsp:config contacts add C0123ABCD              # a whole Slack channel
/openbsp:config contacts                            # show who's allowed
/openbsp:config contacts remove 5491155551234       # remove one
/openbsp:config contacts clear                      # block all again
```

### What Claude sees

```xml
<channel source="openbsp" service="instagram" account="@acme" conversation_id="uuid" sender="17841400000000000" sender_name="John" message_id="uuid">
Hello, I need help with my order
</channel>
```

A message in a group or channel also carries `conversation_name`, and one in a
Slack thread `thread_id`.

### Reply tool

```
Tool: reply
Arguments:
  conversation_id: "uuid"
  text: "Your order is on the way!"
  thread_id: "1730000000.000100"   # optional, from the tag
```

The reply goes out on the conversation's service, from the account that holds
it, as the signed-in member (Slack posts it with their own identity when they
have connected one). It is queued, not delivered: the service may still refuse
it. Each service caps a text's length (WhatsApp 4096, Instagram 1000, TikTok
6000 characters), and a longer reply is refused at once. On WhatsApp, the
24-hour service window applies — if the contact hasn't messaged in 24h, a
template must be sent instead.

## Configuration

All configuration is managed through skills — no need to hand-edit files.

### Check status

```
/openbsp:config
```

Shows: Supabase URL, auth state, org, channel status (active or API-only), and
allowed contacts.

### Multi-org

```
/openbsp:config organization <org-uuid>
```

### Sign in / switch accounts

```
/openbsp:config login    # sign in (Google), or switch accounts
/openbsp:config logout   # clear the saved session
```

### Advanced: environment variables

Env vars override everything (for CI or scripting):

| Variable            | Description                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `SUPABASE_URL`      | Supabase project URL                                             |
| `SUPABASE_ANON_KEY` | Supabase anonymous key                                           |
| `ORG_ID`            | Organization ID (multi-org)                                      |
| `OPENBSP_STATE_DIR` | Override state directory (default: `~/.claude/channels/openbsp`) |

### Config file

All settings are stored in `~/.claude/channels/openbsp/config.json`:

```json
{
  "supabaseUrl": "https://custom.supabase.co",
  "supabaseAnonKey": "eyJ...",
  "orgId": "uuid",
  "allowedContacts": ["5491155551234", "C0123ABCD"]
}
```

All fields are optional — missing keys fall back to hardcoded production
defaults or auto-detection. An empty or missing `allowedContacts` blocks all
channel messages (secure by default).

## Authentication

The plugin uses Google SSO (same as the OpenBSP UI). No API keys or service role
keys needed.

**Sign-in is on demand** — the server starts signed-out and never opens a
browser unprompted. Run `/openbsp:config login`, or let Claude call the `login`
tool when another tool reports "not signed in". The tool opens your browser and
shows the sign-in link in a Claude Code dialog (works in headless/SSH setups —
copy the URL manually). Use `force: true` (or ask to switch accounts) to
re-authenticate as someone else.

The session is saved to `~/.claude/channels/openbsp/session.json` (0600
permissions) and is restored and refreshed automatically on subsequent runs. If
it expires, tools report it and `login` gets you back in — no restart needed.

## File structure

```
plugin/
├── server.ts              # MCP server (query tool + optional Realtime + reply)
├── api-reference.ts       # Curated API reference (MCP resource)
├── auth.ts                # OAuth loopback flow + session persistence
├── config.ts              # Config type, load/save helpers, constants
├── types.ts               # OpenBSP types (subset from _shared/types/)
├── deno.json              # Import map
├── skills/
│   └── configure/
│       └── SKILL.md       # /openbsp:config skill
└── .claude-plugin/
    └── plugin.json        # Plugin metadata
```

## Troubleshooting

**Browser doesn't open for sign-in** The URL is shown in the sign-in dialog (and
in the `login` tool result). Copy and paste it manually. This can happen in
headless/SSH environments.

**"No organization found for this user"** Your Google account isn't associated
with any OpenBSP organization. Sign in to the UI app first to verify your
account.

**Realtime not receiving messages** Check that the `supabase_realtime`
publication includes the `messages` and `conversations` tables. Check the Claude
Code debug log at `~/.claude/debug/<session-id>.txt` for stderr output.

**"blocked by org policy"** Your Team or Enterprise admin needs to
[enable channels](https://code.claude.com/docs/en/channels#enterprise-controls).

**API-only mode (no organization)** The `query` tool still works. `reply` is not
available. Check `/openbsp:config` for details.

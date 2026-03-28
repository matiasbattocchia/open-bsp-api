# OpenBSP Plugin for Claude Code

An [MCP plugin](https://code.claude.com/docs/en/plugins) that gives Claude Code full access to the OpenBSP platform — query any API endpoint, manage contacts, conversations, templates, and more. Optionally bridges WhatsApp messages into your session in real-time via Supabase Realtime.

## How it works

```
┌─────────────────────────────────────────────────────────┐
│  Claude Code                                            │
│    ├─ query tool ──► PostgREST / Edge Functions (API)   │
│    ├─ reply tool ──► messages table → WhatsApp dispatch  │
│    └─ channel ◄──── Supabase Realtime (WhatsApp inbox)  │
└─────────────────────────────────────────────────────────┘
```

1. **API access (always available):** The `query` tool makes authenticated HTTP requests to PostgREST and Edge Functions. Claude reads the `openbsp://api-reference` resource for schema and syntax, then queries freely.
2. **WhatsApp channel (optional):** If a connected WhatsApp account is found, the plugin subscribes to Supabase Realtime. Incoming messages appear as `<channel>` notifications. Claude replies using the `reply` tool.

If no WhatsApp account is available (or resolution fails), the plugin runs in **API-only mode** — `query` works, `reply` is not listed.

## Prerequisites

- [Deno](https://deno.com) v2+
- [Claude Code](https://claude.com/claude-code) v2.1.80+
- An OpenBSP user account (Google SSO)

## Quick start

**Hosted users (zero config):** Production Supabase credentials are built in. Just authenticate with Google and go.

```bash
claude --plugin-dir ./plugin
```

The plugin opens your browser for Google sign-in on first run. After that, sessions are refreshed automatically.

**Self-hosted users:** Point to your own Supabase instance:

```
/openbsp:config configure https://your-project.supabase.co your-anon-key
```

## API access

The `query` tool lets Claude make any authenticated API call. Before the first query, Claude reads the `openbsp://api-reference` resource which contains table schemas, PostgREST syntax, and example queries.

### Example queries

```
# List contacts
query: GET /rest/v1/contacts?select=id,name,status&limit=10&order=name.asc

# Search by name
query: GET /rest/v1/contacts?name=ilike.*john*&select=id,name

# Recent conversations
query: GET /rest/v1/conversations?select=id,contact_address,updated_at&order=updated_at.desc&limit=10

# Messages in a conversation
query: GET /rest/v1/messages?conversation_id=eq.<uuid>&select=id,direction,content,timestamp&order=timestamp.asc

# List WhatsApp templates
query: GET /functions/v1/whatsapp-management/templates
```

Security: paths must start with `/rest/v1/` or `/functions/v1/`. Auth headers are injected automatically.

## WhatsApp channel

When a WhatsApp account is resolved, the plugin subscribes to Realtime and forwards incoming messages to Claude.

### Add contacts (required for channel)

The channel is **secure by default** — no contacts are allowed until explicitly added. All messages from unknown contacts are silently dropped. This does not affect API access (RLS governs that).

```
/openbsp:config contacts add 5491155551234
/openbsp:config contacts add 5491155555678
/openbsp:config contacts                       # show who's allowed
/openbsp:config contacts remove 5491155551234  # remove one
/openbsp:config contacts clear                 # block all again
```

### What Claude sees

```xml
<channel source="openbsp" contact_phone="5491155551234" contact_name="John" direction="incoming" service="whatsapp" message_id="uuid">
Hello, I need help with my order
</channel>
```

### Reply tool

```
Tool: reply
Arguments:
  contact_phone: "5491155551234"
  text: "Your order is on the way!"
```

The 24-hour service window applies — if the contact hasn't messaged in 24h, a template must be sent instead.

## Configuration

All configuration is managed through skills — no need to hand-edit files.

### Check status

```
/openbsp:config
```

Shows: Supabase URL, auth state, org, WhatsApp account, channel status (active or API-only), and allowed contacts.

### Multi-org / multi-account

```
/openbsp:config organization <org-uuid>
/openbsp:config account <phone-digits>
```

### Force re-authentication

```
/openbsp:config login
```

### Advanced: environment variables

Env vars override everything (for CI or scripting):

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anonymous key |
| `ORG_ID` | Organization ID (multi-org) |
| `ACCOUNT_PHONE` | WhatsApp account phone, digits only (multi-account) |
| `OPENBSP_STATE_DIR` | Override state directory (default: `~/.claude/channels/openbsp`) |

### Config file

All settings are stored in `~/.claude/channels/openbsp/config.json`:

```json
{
  "supabaseUrl": "https://custom.supabase.co",
  "supabaseAnonKey": "eyJ...",
  "orgId": "uuid",
  "accountPhone": "1234567890",
  "allowedContacts": ["5491155551234"]
}
```

All fields are optional — missing keys fall back to hardcoded production defaults or auto-detection. An empty or missing `allowedContacts` blocks all channel messages (secure by default).

## Authentication

The plugin uses Google SSO (same as the OpenBSP UI). No API keys or service role keys needed.

**First run:** opens your browser for Google sign-in. The session is saved to `~/.claude/channels/openbsp/session.json` (0600 permissions).

**Subsequent runs:** the saved session is loaded and refreshed automatically. If the refresh token is expired, the browser opens again.

## File structure

```
plugin/
├── server.ts              # MCP server (query tool + optional Realtime + reply)
├── api-reference.ts       # Curated API reference (MCP resource)
├── auth.ts                # OAuth loopback flow + session persistence
├── config.ts              # Config type, load/save helpers, constants
├── types.ts               # OpenBSP types (subset from _shared/supabase.ts)
├── deno.json              # Import map
├── skills/
│   └── configure/
│       └── SKILL.md       # /openbsp:config skill
└── .claude-plugin/
    └── plugin.json        # Plugin metadata
```

## Troubleshooting

**Browser doesn't open for sign-in**
The URL is printed to stderr. Copy and paste it manually. This can happen in headless/SSH environments.

**"No organization found for this user"**
Your Google account isn't associated with any OpenBSP organization. Sign in to the UI app first to verify your account.

**"Multiple accounts found"**
Set the account phone: `/openbsp:config account <phone>`

**Realtime not receiving messages**
Check that the `supabase_realtime` publication includes the `messages` and `conversations` tables. Check the Claude Code debug log at `~/.claude/debug/<session-id>.txt` for stderr output.

**"blocked by org policy"**
Your Team or Enterprise admin needs to [enable channels](https://code.claude.com/docs/en/channels#enterprise-controls).

**API-only mode (no WhatsApp account)**
The `query` tool still works. `reply` is not available. Check `/openbsp:config` for details.

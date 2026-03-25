# OpenBSP WhatsApp Channel for Claude Code

A [Claude Code channel](https://code.claude.com/docs/en/channels-reference) that bridges WhatsApp messages into your Claude Code session via Supabase Realtime. Claude receives incoming WhatsApp messages in real-time and can reply back through the `reply` tool.

## How it works

```
WhatsApp Cloud API
      │
      ▼
  Supabase DB  ◄──trigger──  reply tool (INSERT outgoing message)
      │                            ▲
      │ Realtime (WebSocket)       │ MCP tool call
      ▼                            │
  Channel Server  ──stdio──►  Claude Code
  (local subprocess)
```

1. WhatsApp messages arrive in the `messages` table via the existing OpenBSP pipeline
2. The channel server subscribes to Supabase Realtime (same as the UI app)
3. Incoming messages are pushed to Claude Code as `<channel>` notifications
4. Claude replies using the `reply` tool, which inserts an outgoing message — the existing `handle_outgoing_message_to_dispatcher` trigger routes it to WhatsApp

## Prerequisites

- [Deno](https://deno.com) v2+
- [Claude Code](https://claude.com/claude-code) v2.1.80+
- An OpenBSP user account (Google SSO)

## Quick start

**Hosted users (zero config):** Production Supabase credentials are built in. Just authenticate with Google and go.

```bash
claude --dangerously-load-development-channels server:openbsp
```

The channel opens your browser for Google sign-in on first run. After that, sessions are refreshed automatically.

**Self-hosted users:** Point to your own Supabase instance:

```
/openbsp:configure https://your-project.supabase.co your-anon-key
```

## Configuration

All configuration is managed through skills — no need to hand-edit files.

### Check status

```
/openbsp:config
```

Shows: Supabase URL (default or custom), auth state, org, account, and allowed contacts.

### Add contacts (required)

The channel is **secure by default** — no contacts are allowed until explicitly added. All messages from unknown contacts are silently dropped.

```
/openbsp:config contacts add 5491155551234
/openbsp:config contacts add 5491155555678
/openbsp:config contacts                       # show who's allowed
/openbsp:config contacts remove 5491155551234  # remove one
/openbsp:config contacts clear                 # block all again
```

### Multi-org / multi-account

```
/openbsp:config organization <org-uuid>
/openbsp:config account <phone-digits>
```

### Other commands

```
/openbsp:config login    # clear session, force re-auth on next start
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

All fields are optional — missing keys fall back to hardcoded production defaults or auto-detection. An empty or missing `allowedContacts` blocks all messages (secure by default).

## Authentication

The channel uses Google SSO (same as the OpenBSP UI). No API keys or service role keys needed.

**First run:** opens your browser for Google sign-in. The session is saved to `~/.claude/channels/openbsp/session.json` (0600 permissions).

**Subsequent runs:** the saved session is loaded and refreshed automatically. If the refresh token is expired, the browser opens again.

## What Claude sees

When a WhatsApp message arrives:

```xml
<channel source="openbsp" contact_phone="5491155551234" contact_name="John" direction="incoming" service="whatsapp" message_id="uuid">
Hello, I need help with my order
</channel>
```

### Reply tool

Claude replies using the `reply` tool:

```
Tool: reply
Arguments:
  contact_phone: "5491155551234"
  text: "Your order is on the way!"
```

The 24-hour service window applies — if the contact hasn't messaged in 24h, a template must be sent instead.

## File structure

```
channel/
├── server.ts              # MCP channel server (Realtime + reply tool)
├── auth.ts                # OAuth loopback flow + session persistence
├── config.ts              # Config type, load/save helpers, constants
├── types.ts               # OpenBSP types (subset from _shared/supabase.ts)
├── deno.json              # Import map
├── .mcp.json              # MCP server config for Claude Code
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
Set the account phone: `/openbsp:configure account <phone>`

**Realtime not receiving messages**
Check that the `supabase_realtime` publication includes the `messages` and `conversations` tables. Check the Claude Code debug log at `~/.claude/debug/<session-id>.txt` for stderr output.

**"blocked by org policy"**
Your Team or Enterprise admin needs to [enable channels](https://code.claude.com/docs/en/channels#enterprise-controls).

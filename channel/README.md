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
- A Supabase project with OpenBSP deployed
- An OpenBSP user account (Google SSO)

## Configuration

### 1. Create the state directory and `.env` file

```bash
mkdir -p ~/.claude/channels/openbsp
```

Create `~/.claude/channels/openbsp/.env` with your Supabase credentials:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ...
```

These are the same values as `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the UI app.

### 2. Optional environment variables

Set these in the `.env` file if needed:

| Variable | Description |
|---|---|
| `ORG_ID` | Organization ID to use (required if your account belongs to multiple organizations) |
| `ACCOUNT_PHONE` | WhatsApp account phone number, digits only (required if the org has multiple WhatsApp accounts) |
| `OPENBSP_STATE_DIR` | Override the state directory (default: `~/.claude/channels/openbsp`) |

### 3. Sender gating (optional)

Create `~/.claude/channels/openbsp/access.json` to restrict which contacts can push messages into your Claude session:

```json
{
  "allowedContacts": ["5491155551234", "5491155555678"]
}
```

If the file is missing or `allowedContacts` is empty, **all contacts** are forwarded. For security, configure this when using the channel in contexts where prompt injection is a concern.

## Authentication

The channel uses the same Google SSO as the OpenBSP UI app. No API keys or service role keys needed.

**First run:** the server opens your browser for Google sign-in. After authentication, the session (JWT + refresh token) is saved to `~/.claude/channels/openbsp/session.json`.

**Subsequent runs:** the saved session is loaded automatically. If the token has expired, the Supabase client refreshes it. If the refresh token is also expired, the browser opens again.

The session file is created with `0600` permissions (owner-only read/write).

## Usage

### Development (research preview)

During the research preview, custom channels require the development flag:

```bash
claude --dangerously-load-development-channels server:openbsp
```

This tells Claude Code to:
1. Read `.mcp.json` and spawn the channel server as a subprocess
2. Connect over stdio and register the `claude/channel` notification listener
3. The server authenticates, resolves your org/account, and subscribes to Realtime

### What Claude sees

When a WhatsApp message arrives:

```xml
<channel source="openbsp" contact_phone="5491155551234" contact_name="John" direction="incoming" service="whatsapp" message_id="uuid">
Hello, I need help with my order
</channel>
```

New conversations also emit an event:

```xml
<channel source="openbsp" contact_phone="5491155551234" contact_name="John" event="new_conversation" service="whatsapp">
New conversation started with John
</channel>
```

### Reply tool

Claude can send messages back using the `reply` tool:

```
Tool: reply
Arguments:
  contact_phone: "5491155551234"  (from the channel tag)
  text: "Your order is on the way!"
```

The reply is inserted as an outgoing message and dispatched to WhatsApp through the existing pipeline. The 24-hour service window applies — if the contact hasn't messaged in 24h, a template must be sent instead (via the existing MCP server's `send_message` tool).

## Relationship with the existing MCP server

| | Edge Function MCP Server | Claude Code Channel |
|---|---|---|
| **Transport** | Streamable HTTP (remote) | stdio (local subprocess) |
| **Runs where** | Supabase cloud | Your local machine |
| **Push capability** | No (request-response) | Yes (Realtime notifications) |
| **Auth** | API key | Google OAuth (JWT) |
| **Tools** | Full suite (conversations, contacts, templates, send) | `reply` only |
| **Who can use it** | Any MCP client | Claude Code only |

They complement each other. The channel provides real-time push (incoming messages appear as they arrive), while the edge function MCP server provides the full tool suite for querying conversations, searching contacts, managing templates, etc.

## File structure

```
channel/
├── server.ts              # MCP channel server (Realtime + reply tool)
├── auth.ts                # OAuth loopback flow + session persistence
├── types.ts               # OpenBSP types (subset from _shared/supabase.ts)
├── deno.json              # Import map
├── .mcp.json              # MCP server config for Claude Code
└── .claude-plugin/
    └── plugin.json        # Plugin metadata
```

## Troubleshooting

**"SUPABASE_URL and SUPABASE_ANON_KEY required"**
Create the `.env` file as described in [Configuration](#1-create-the-state-directory-and-env-file).

**Browser doesn't open for sign-in**
The URL is printed to stderr. Copy and paste it manually. This can happen in headless/SSH environments.

**"No organization found for this user"**
Your Google account isn't associated with any OpenBSP organization. Sign in to the UI app first to verify your account.

**"Multiple accounts found"**
Set `ACCOUNT_PHONE` in the `.env` file to select which WhatsApp account to use.

**Realtime not receiving messages**
Check that the `supabase_realtime` publication includes the `messages` and `conversations` tables (it should if OpenBSP migrations have been applied). Check the Claude Code debug log at `~/.claude/debug/<session-id>.txt` for stderr output from the channel.

**"blocked by org policy"**
Your Team or Enterprise admin needs to [enable channels](https://code.claude.com/docs/en/channels#enterprise-controls).

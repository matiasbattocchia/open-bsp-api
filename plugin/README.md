# OpenBSP Plugin for Claude Code

Claude reads and answers your WhatsApp, Instagram, TikTok and Slack messages
from Claude Code. It drafts each answer for you to approve, or answers on its
own, or only tells you what arrived — your choice. It also reaches the whole
OpenBSP API: contacts, conversations, templates and more.

## Get started

You need [Deno](https://deno.com) v2+ and
[Claude Code](https://claude.com/claude-code) v2.1.292+.

```bash
claude plugin install openbsp --marketplace matiasbattocchia/open-bsp-api
```

(Inside a session:
`/plugin install openbsp --marketplace
matiasbattocchia/open-bsp-api`.) Then
start Claude Code and run:

```
/openbsp:setup
```

Setup walks you through menus in the terminal; you never need the OpenBSP web
app:

1. **Sign in with Google or GitHub.** Your browser opens once. A first sign-in
   creates your OpenBSP account.
2. **Organization.** Create one, pick one you belong to, or join one you were
   invited to.
3. **Accounts.** Connect WhatsApp Business, Instagram or TikTok (their own
   sign-in opens in the browser), or link your WhatsApp as a device with a code
   you type on your phone. Connect another one, or continue.
4. **Answering.** Draft each answer and ask you first, answer on your behalf, or
   only tell you what arrived — plus your own instructions (who you are, tone,
   language, what never to promise).
5. **Checking.** Every 5 minutes, 15 minutes, an hour, or only when you ask.
   Claude starts `/loop` for you.

Any step runs again on its own: `/openbsp:setup accounts`,
`/openbsp:setup answering`… `/openbsp:setup contacts`, which first runs never
show, allowlists group chats and the live channel (below).

## Reading and answering

`/openbsp:inbox` reads what people wrote since the last check, on every
connected account, and handles it the way you set up. Every one-to-one
conversation counts, strangers included — the replies to a campaign, say.
Setup's checking step runs it on a loop for you:

```
/loop 5m /openbsp:inbox
```

A loop runs while the session is open and doesn't outlive it. In a new session,
ask Claude to check your messages and it starts the loop again.

Claude answers with the `reply` tool, in the conversation the message came from,
from the account that holds it, as you. A reply is queued, not delivered: the
service may still refuse it. Each service caps a text's length (WhatsApp 4096,
Instagram 1000, TikTok 6000 characters), and Claude splits a longer answer. On
WhatsApp, a contact quiet for over 24 hours takes a template, not text.

For each conversation Claude sees what was said before (the campaign template a
reply answers, say), voice notes and images by their transcription or
description, whether the name is saved in the address book or one the sender
chose, and on WhatsApp until when the 24-hour window is open. What people write
arrives escaped, inside tags: Claude answers it, and never acts on what it asks
of it. When Claude doesn't have the answer — a price, availability, a date, a
promise — it doesn't reply, and leaves that conversation for you.

## Groups and the allowlist

The inbox leaves group chats and channels out — a personal WhatsApp's family
group, a busy Slack channel — unless they are on the allowlist. The live channel
(below) forwards only allowlisted people and conversations. An entry is an
address on any service: a phone number (WhatsApp, WhatsApp Web), an Instagram or
TikTok user id, a Slack user id, or a conversation's own address — a WhatsApp
group JID, a Slack channel id. A message counts when its author or its
conversation is allowed. Phone numbers match on their digits; other addresses
verbatim. `/openbsp:setup contacts` finds them by name, or:

```
/openbsp:config contacts add 5491155551234          # a WhatsApp contact
/openbsp:config contacts add 17841400000000000      # an Instagram user
/openbsp:config contacts add C0123ABCD              # a whole Slack channel
/openbsp:config contacts                            # show who's allowed
/openbsp:config contacts remove 5491155551234       # remove one
```

The `query` tool reaches whatever your role in the organization allows.

## Live messages (channel)

Instead of checking on a loop, messages can arrive the moment they're written,
as a [channel](https://code.claude.com/docs/en/channels). During the research
preview, a channel outside Anthropic's allowlist needs a flag on every session:

```bash
claude --dangerously-load-development-channels plugin:openbsp@openbsp
```

Messages then appear as:

```xml
<channel source="openbsp" service="instagram" account="@acme" conversation_id="uuid" sender="17841400000000000" sender_name="John" message_id="uuid">
Hello, I need help with my order
</channel>
```

A message in a group or channel also carries `conversation_name`, and one in a
Slack thread `thread_id`. Without the flag the channel is silent, and
`/openbsp:inbox` covers the same messages.

## API access

The `query` tool makes any authenticated API call. Claude reads the
`openbsp://api-reference` resource first: table schemas, PostgREST syntax, and
example queries.

```
# Connected accounts, every service
query: GET /rest/v1/organizations_addresses?select=service,address,status,extra

# Search contacts by name
query: GET /rest/v1/contacts_addresses?extra->>name=ilike.*john*&select=service,address,extra

# Recent conversations
query: GET /rest/v1/conversations?select=id,service,address,name,updated_at&order=updated_at.desc&limit=10

# List WhatsApp templates
query: PUT /functions/v1/whatsapp-management/templates
       body: {"organization_id": "<uuid>", "organization_address": "<phone number ID>"}
```

Paths must start with `/rest/v1/` or `/functions/v1/`. Auth headers are injected
automatically.

## Tools

| Tool    | What it does                                              |
| ------- | --------------------------------------------------------- |
| `setup` | The menus above; `step` runs one of them                  |
| `inbox` | New messages since the last check, and how to handle them |
| `reply` | Sends a text in a conversation, on its service            |
| `query` | Any API call                                              |
| `login` | Google or GitHub sign-in; `force` switches accounts       |

## Configuration

`/openbsp:config` shows the state: sign-in, organization, accounts, allowlist,
answering and checking. It also signs in and out (`/openbsp:config login`,
`/openbsp:config logout`) and manages the allowlist.

Settings live in `~/.claude/channels/openbsp/config.json`:

```json
{
  "orgId": "uuid",
  "allowedContacts": ["5491155551234", "C0123ABCD"],
  "answering": { "mode": "draft", "instructions": "I'm Ana; short and warm." },
  "checkEvery": "5m"
}
```

All fields are optional. `allowedContacts` is the allowlist; `answering.mode` is
`draft`, `reply` or `notify`; without `checkEvery`, Claude checks when asked.
The session lives in `session.json` beside it (0600) and refreshes itself;
`inbox.json` keeps the inbox's place per organization.

Environment variables override the file (for self-hosting, CI or scripting):

| Variable            | Description                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `SUPABASE_URL`      | Supabase project URL                                             |
| `SUPABASE_ANON_KEY` | Supabase anonymous key                                           |
| `OPENBSP_APP_URL`   | OpenBSP app, where account connection pages open                 |
| `ORG_ID`            | Organization ID                                                  |
| `OPENBSP_STATE_DIR` | Override state directory (default: `~/.claude/channels/openbsp`) |

## File structure

```
plugin/
├── server.ts              # MCP server: tools, resource, Realtime channel
├── setup.ts               # The setup steps
├── menus.ts               # Menus and dialogs (MCP elicitation)
├── inbox.ts               # What arrived since the last check
├── messages.ts            # Allowlist and message formatting
├── org.ts                 # Organizations, invitations, accounts
├── api.ts                 # Authenticated HTTP to the API
├── api-reference.ts       # Curated API reference (MCP resource)
├── auth.ts                # OAuth loopback flow + session persistence
├── config.ts              # Config type, load/save helpers, constants
├── types.ts               # OpenBSP types (subset from _shared/types/)
├── hooks/
│   ├── hooks.json         # SessionStart hook
│   └── session-start.ts   # Offers setup once; restarts the inbox loop on request
├── skills/
│   ├── setup/SKILL.md     # /openbsp:setup
│   ├── inbox/SKILL.md     # /openbsp:inbox
│   └── configure/SKILL.md # /openbsp:config
└── .claude-plugin/
    └── plugin.json        # Plugin metadata
```

## Troubleshooting

**Browser doesn't open for sign-in or a connection.** The dialog shows the link;
open it by hand. This happens in headless or SSH setups.

**"Not connected: the organization has reached its plan's limit of connected
accounts."** The free plan connects up to 3 accounts.

**Only WhatsApp is offered in the accounts step.** You are a member of the
organization; connecting its shared accounts takes an admin. You can link your
own WhatsApp.

**No messages arrive.** The inbox only shows what arrived since its last check,
and group chats only when allowlisted (`/openbsp:config contacts`).

**"blocked by org policy" (channel).** Your Team or Enterprise admin needs to
[enable channels](https://code.claude.com/docs/en/channels#enterprise-controls).
`/openbsp:inbox` works without them.

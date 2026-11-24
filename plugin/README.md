# OpenBSP Plugin for Claude Code

Claude reads and answers your WhatsApp, Instagram, TikTok and Slack messages
from Claude Code — it asks you before each one goes out, or sends on its own, or
only tells you what arrived. It also reaches the whole OpenBSP API: contacts,
conversations, templates and more.

## Get started

You need [Node.js](https://nodejs.org) v20+ and
[Claude Code](https://claude.com/claude-code) v2.1.292+.

```bash
claude plugin install openbsp --marketplace matiasbattocchia/open-bsp-api
```

(Inside a session:
`/plugin install openbsp --marketplace
matiasbattocchia/open-bsp-api`.) The
install asks for the [permission mode](#the-permission-mode). Then Claude offers
to set OpenBSP up: say yes, or ask it any time ("set up OpenBSP", "connect my
Instagram").

Setup asks one question at a time in Claude Code's picker, straight from the
plugin — Claude only gets the summary — and you never need the OpenBSP web app.
Arrows move, Enter picks and goes on, "Type something" takes a name or anything
not listed, and Esc stops. Actions are marked apart from the names around them:
`+` creates or connects, `←` goes back, `↑`/`↓` page, `✓` goes on.

1. **Sign in with Google or GitHub.** Your browser opens once. A first sign-in
   creates your OpenBSP account.
2. **Organization.** Create one, pick one you belong to, or join one you were
   invited to. Many page down (`↓ Down`, `↑ Up`), or type part of a name to find
   one.
3. **Accounts.** WhatsApp through the official API (a business account),
   Instagram or TikTok: their own sign-in opens in the browser. Or WhatsApp Web,
   any account through an unofficial API: you type a code on your phone.
   WhatsApp may ban a number linked this way, above all one messaging people who
   haven't saved it — campaigns belong on the official API. Connect more, or go
   on.
4. **Checking.** Every 3 or 10 minutes, or only when you ask. Claude starts
   `/loop` for you.

Then tell Claude how, when and what to answer: who you are, the tone, what never
to promise. That's yours to say, not a setting — keep it in your `CLAUDE.md` for
later sessions.

Any step runs again on its own: ask Claude to connect another account, switch
organization or change how often it checks.

## The permission mode

Whether Claude may send messages and change things is set in `/config` (search
OpenBSP), and at install:

- **read** — Claude never sends or changes anything; it shows you drafts.
- **ask** (the default) — Claude Code asks you to approve each message Claude
  sends, showing all of it, and each change through the `query` tool (anything
  but a read). "No" stops Claude there; "No, tell Claude what to do differently"
  (Tab) lets it go on with the rest.
- **allow** — Claude sends and changes things on its own.

The plugin enforces it whatever Claude Code's own permission mode, bypass
included, and a change takes effect at once. Only `/config` changes it: an edit
to Claude Code's settings files made some other way (by hand, or by a tool
Claude ran) can't loosen it — the plugin refuses it and keeps refusing it in
later sessions, until the mode is set in `/config`.

Where Claude Code doesn't run the plugin's hooks (`disableAllHooks`,
`--safe-mode`, an organization policy), the plugin's server enforces the mode it
started with, in a dialog of its own; after changing the mode there, run
`/reload-plugins`.

## Reading and answering

`/openbsp:inbox` reads what people wrote since the last check, on every
connected account, and handles it the way you told Claude. Every one-to-one
conversation counts, strangers included — the replies to a campaign, say.
Setup's checking step runs it on a loop for you:

```
/loop 3m /openbsp:inbox
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

## Groups and channels

A group chat or a channel — a personal WhatsApp's family group, a busy Slack
channel — comes into the inbox as one line: how many new messages, who wrote,
when the last one came, but not what they said. Claude tells you which ones were
busy, opens one when you ask (the `inbox` tool with its `conversation_id`), and
answers in one only when you ask it to. There is nothing to set up.

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

| Tool     | What it does                                              |
| -------- | --------------------------------------------------------- |
| `setup`  | The questions above; `step` runs one of them              |
| `status` | What is set up: sign-in, organization, accounts, checking |
| `inbox`  | New messages since the last check; or one conversation    |
| `reply`  | Sends a text in a conversation, on its service            |
| `query`  | Any API call                                              |
| `login`  | Google or GitHub sign-in; `force` switches accounts       |
| `logout` | Signs out on this computer                                |

(`hooks` is the plugin's own handshake; Claude can't call it.)

## Configuration

The plugin keeps its files in the folder Claude Code gives it,
`~/.claude/plugins/data/openbsp-openbsp/`, kept across updates and removed when
you uninstall. (Versions up to 0.7 used `~/.claude/channels/openbsp/`; the
plugin moves the files over on its first start.) Setup's answers are in
`config.json`:

```json
{
  "orgId": "uuid",
  "checkEvery": "3m"
}
```

Both fields are optional; without `checkEvery`, Claude checks when asked. The
permission mode isn't here: it's in Claude Code's settings (`/config`). The
session lives in `session.json` beside it (0600) and refreshes itself;
`inbox.json` keeps the inbox's place per organization. A working copy loaded
with `--plugin-dir` gets a folder of its own, `openbsp-inline`: delete its files
to start over.

## Self-hosting

The plugin talks to the hosted OpenBSP at
[web.openbsp.dev](https://web.openbsp.dev) with nothing to set. To point it at
your own deployment, add three environment variables to the `env` block of your
Claude Code settings (`~/.claude/settings.json`), which the plugin's server
inherits in every session:

```json
{
  "env": {
    "SUPABASE_URL": "https://<project-ref>.supabase.co",
    "SUPABASE_ANON_KEY": "<the project's anon or publishable key>",
    "OPENBSP_APP_URL": "https://<your OpenBSP web app>"
  }
}
```

| Variable            | What it is                                               |
| ------------------- | -------------------------------------------------------- |
| `SUPABASE_URL`      | Your Supabase project's URL                              |
| `SUPABASE_ANON_KEY` | Its anon (publishable) key, the one the web app uses     |
| `OPENBSP_APP_URL`   | Your web app, where the pages that connect accounts open |

For one session only, a local stack say, set them on the command line instead:
`SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=… claude`. A change takes
effect in a new session or after `/reload-plugins`. A sign-in belongs to the
deployment it was made on: after switching, ask Claude to sign you in again.

## File structure

```
plugin/
├── server.ts              # MCP server: tools and resource
├── setup.ts               # The setup steps
├── modes.ts               # The permission modes, shared with the hooks module
├── permission.ts          # The mode where Claude Code's hooks don't run
├── dialogs.ts             # Dialogs that wait (MCP elicitation)
├── inbox.ts               # Where the inbox left off, on this computer
├── org.ts                 # Organizations, invitations, accounts
├── api.ts                 # Authenticated HTTP to the API
├── auth.ts                # OAuth loopback flow + session persistence
├── config.ts              # Config type, load/save helpers, constants
├── types.ts               # OpenBSP types (subset from _shared/types/)
├── hooks/
│   ├── hooks.json         # Names the hooks module
│   ├── register.ts        # The mode, the setup questions, what Claude knows
│   └── register.test.ts   # Its tests (claude plugin test)
├── dist/                  # What Node runs: server.ts, bundled
├── deno.json              # Dev tooling, and `deno task bundle`
├── skills/
│   └── inbox/SKILL.md     # /openbsp:inbox
└── .claude-plugin/
    └── plugin.json        # Plugin metadata, and the permission mode setting
```

The server is TypeScript, checked and bundled with Deno; the plugin runs the
bundle on Node. It shares the inbox's reading, the organization helpers and the
API reference with the remote MCP server, from `supabase/functions/_shared/`
(`inbox.ts`, `organizations.ts`, `api_reference.ts`), which therefore use
neither Node nor Deno. After changing a `.ts` file outside `hooks/`, or one of
those, run `deno task bundle` in `plugin/` and commit `dist/` with it — CI fails
when they differ.

`hooks/register.ts` is a Claude Code
[mod](https://code.claude.com/docs/en/plugins/mods/create): Claude Code loads it
as it is, and its types come with Claude Code, so Deno only lints it. Check it
with `claude plugin validate plugin` and `claude plugin test plugin`, and try it
with `claude --plugin-dir plugin`, which reloads it on every save.

## Troubleshooting

**Browser doesn't open for sign-in or a connection.** The dialog shows the link;
open it by hand. This happens in headless or SSH setups.

**"Not connected: the organization has reached its plan's limit of connected
accounts."** The free plan connects up to 3 accounts.

**Only WhatsApp is offered in the accounts step.** You are a member of the
organization; connecting its shared accounts takes an admin. You can link your
own WhatsApp.

**No messages arrive.** The inbox only shows what arrived since its last check,
and a group chat as one line (ask Claude to open it).

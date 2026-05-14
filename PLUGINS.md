# Plugins

wakit has a plugin system that lets you enable optional features on top of the core WhatsApp Business API platform.

## Core vs Plugins

**Core** — always deployed, provides the essential WhatsApp messaging infrastructure:

| Function | Description |
|----------|-------------|
| `whatsapp-webhook` | Receives incoming messages and status updates from Meta |
| `whatsapp-dispatcher` | Sends outgoing messages to WhatsApp Cloud API |
| `whatsapp-management` | WhatsApp account management (signup, templates) |
| `agent-client` | AI agent message processing |
| `media-preprocessor` | Media file processing (transcription, OCR) |
| `mcp` | Model Context Protocol server for AI integrations |
| `api` | REST API for external integrations (n8n, custom apps) |

**Plugins** — optional features you enable based on your needs:

| Plugin | Functions | Description |
|--------|-----------|-------------|
| `stripe` | `stripe-checkout`, `stripe-webhook`, `stripe-portal` | Stripe billing integration with checkout, webhooks, and customer portal |
| `migrate-twilio` | `migrate-twilio` | Twilio migration wizard for importing numbers, templates, and webhooks |

## Configuration

Plugins are configured in `wakit.config.json` at the project root:

```json
{
  "plugins": {
    "stripe": {
      "enabled": true,
      "description": "Stripe billing integration",
      "functions": ["stripe-checkout", "stripe-webhook", "stripe-portal"],
      "env": ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_STARTER_PRICE_ID", "STRIPE_PRO_PRICE_ID"]
    },
    "migrate-twilio": {
      "enabled": false,
      "description": "Twilio migration wizard",
      "functions": ["migrate-twilio"],
      "env": []
    }
  }
}
```

Set `"enabled": true` to deploy a plugin, `false` to skip it.

## Deployment

Use the deploy script instead of `supabase functions deploy`:

```bash
# Deploy core + enabled plugins
bash scripts/deploy.sh

# Deploy only core (no plugins)
bash scripts/deploy.sh --core-only

# Deploy everything (core + all plugins)
bash scripts/deploy.sh --all
```

The script reads `wakit.config.json` and deploys accordingly.

## Environment variables

Each plugin may require environment variables. Set them via:

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_...
```

The `env` field in `wakit.config.json` lists the required variables for each plugin.

## Database schemas

The billing schema (`supabase/schemas/06_billing/`) is always applied during migrations but is designed to be inert without configuration — billing triggers gracefully skip when no products or subscriptions exist.

Billing seed data in `seed.sql` is clearly marked with comments. Remove the `PLUGIN: Billing` section if you don't use billing at all.

## Creating a new plugin

1. Create your edge function in `supabase/functions/{your-function}/index.ts`
2. Register it in `supabase/config.toml`:
   ```toml
   # plugin: your-plugin
   [functions.your-function]
   verify_jwt = false
   ```
3. Add it to `wakit.config.json`:
   ```json
   "your-plugin": {
     "enabled": false,
     "description": "What it does",
     "functions": ["your-function"],
     "env": ["YOUR_API_KEY"]
   }
   ```
4. Update `scripts/deploy.sh` — add your function to `ALL_PLUGIN_FUNCTIONS`
5. Document in this file

## CLI

wakit includes a command-line interface in the `cli/` directory. Install and use it with:

```bash
cd cli && npm install && npm run build
node dist/index.js init       # configure API key and default account

# Or install globally
npm link
wakit init
```

Commands:

```bash
wakit status                                    # connection status
wakit conversations                             # list recent conversations
wakit chat <phone>                              # view conversation history
wakit send <phone> "Hello"                      # send text message
wakit send <phone> --template welcome --vars "Juan"  # send template
wakit contacts <query>                          # search contacts
wakit templates                                 # list WhatsApp templates
wakit switch <account>                          # change default account
```

All commands support `--json` for machine-readable output and `--from <phone>` to override the default account.

# Contributing

Thanks for your interest in contributing to Open BSP API!

## Local Setup

Requires Node and Docker.

1. Clone the repo:
   ```bash
   git clone https://github.com/matiasbattocchia/open-bsp-api
   cd open-bsp-api
   ```

2. Start the local Supabase instance:
   ```bash
   npx supabase start
   ```

3. Serve Edge Functions locally:
   ```bash
   npx supabase functions serve
   ```

## Database Changes

- Edit schema files in `supabase/schemas/` (never create tables directly via SQL)
- Generate a migration: `npx supabase db diff -f <migration_name>`
- Apply it locally: `npx supabase migration up`
- Regenerate types: `npx supabase gen types typescript --local > supabase/functions/_shared/db_types.ts`

## Submitting Changes

1. Fork the repo and create a branch from `develop`
2. Make your changes
3. Open a pull request with a clear description

PRs are welcome for bug fixes, new tools, protocol support, and documentation.

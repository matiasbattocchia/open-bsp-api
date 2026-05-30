# Contributing

Thanks for your interest in contributing to OpenBSP API!

## Local Setup

Requires Node, Docker, and
[Deno](https://docs.deno.com/runtime/getting_started/installation/) (used by the
Edge Functions and the CI checks).

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

- Edit schema files in `supabase/schemas/` (never create tables directly via
  SQL)
- Generate a migration: `npx supabase db diff -f <migration_name>`
- Apply it locally: `npx supabase migration up`
- Regenerate types:
  `npx supabase gen types typescript --local > supabase/functions/_shared/db_types.ts`

## Code Checks

CI runs `.github/workflows/check.yml` on every push and pull request. Run the
same checks locally before pushing so they pass:

```bash
# 1. Format the whole repo (CI runs `deno fmt --check`)
deno fmt

# 2. Lint and type-check the Edge Functions
cd supabase/functions && deno lint && deno check . && cd ../..

# 3. Lint and type-check the plugin
cd plugin && deno lint && deno check . && cd ..
```

`deno fmt` formats in place; CI only verifies (`deno fmt --check`), so a commit
with unformatted files — including Markdown such as `README.md` or the docs in
the repo root — will fail the check. Run `deno fmt --check` to preview what
would fail without changing any files.

## Submitting Changes

1. Fork the repo and create a branch from `develop`
2. Make your changes
3. Run the [code checks](#code-checks) and ensure they pass
4. Open a pull request with a clear description

PRs are welcome for bug fixes, new tools, protocol support, and documentation.

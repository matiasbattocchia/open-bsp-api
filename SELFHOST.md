# Self-hosting guide

Our self-hosted Supabase is deployed inside a Kubernetes cluster.
We used these [Helm 3 charts](https://github.com/supabase-community/supabase-kubernetes).

### Custom files

- supabase/functions/main/index.ts
- supabase/deploy-functions.sh
- .github/workflows/self-host.yml

### Repo secrets and variables

- `SUPABASE_URL` (variable)
- `SUPABASE_DB_URL` (secret)
- `SUPABASE_SERVICE_ROLE_KEY` (secret)

### TODO

- Edge Functions .env for DEV and PROD
- Edge Functions JWT check

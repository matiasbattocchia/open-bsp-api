---
trigger: always_on
---

1. Edit schema files as needed at `supabase/schemas`.

2. After editing the schema files, generate a migration

```
npx supabase db diff -f <migration_name>
```

3. Ask for confirmation before applying the migration to the local database

```
npx supabase migration up
```

4. Finally, update the types

```
npx supabase gen types typescript --local > supabase/functions/_shared/db_types.ts
```

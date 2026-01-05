---
trigger: always_on
---

1. Edit schema files as needed at `supabase/schemas`.

2. After editing the schema files, ask the user if you can generate a migration

```
npx supabase db diff -f <migration_name>
```

3. Ask the user if you can apply the migration to the local database

```
npx supabase migration up
```

4. Finally, update the types

```
npx supabase gen types typescript --local > supabase/functions/_shared/db_types.ts
```

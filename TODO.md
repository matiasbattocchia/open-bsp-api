# TODO

- [ ] Langfuse integration

- [ ] Encrypt API keys

- [ ] Improved error handling
  https://modelcontextprotocol.io/specification/2025-03-26/server/tools#error-handling

- [x] Timestamp precision (JS milliseconds vs PostgreSQL microseconds)

- [x] API keys equal agents (same roles and policies)

- [ ] Split supabase.ts into different files

- [x] Revisit contacts and contacts_addresses
- [ ] Respond to all / non-contacts
- [ ] Enhanced privacy (optional, do not store messages from contacts)

- [ ] Coexistence welcome message pauses the conversation

---

- [ ] Revisit whatsapp-management security

- [x] Sanitize tool names 

Error: 400 Invalid 'tools[0].function.name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.
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

* Revisar la seguridad de whatsapp-management

* Errores de OpenAI client que no se manejan

Error: 400 Tool call validation failed: tool call validation failed: attempted to call tool 'calendario__list_events' which was not in request.tools

* organization_id no encuentra en account_update porque no se buscan orgs accounts por waba_id

* download media failures while history messages sync
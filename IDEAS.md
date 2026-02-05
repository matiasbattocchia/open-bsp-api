# Ideas

## Managed Agents (Prototype Inheritance)

### Problem

A user builds an agent solution (e.g., for currency exchange) on the hosted platform and wants to offer it to other businesses in the same industry. Current challenges:

- **Cloning doesn't scale** - API keys/OAuth can't transfer, updates don't propagate
- **No sharing mechanism** - agents are strictly isolated per organization
- **Setup complexity** - tools requiring external integrations are hard for non-technical users

### Proposed Solution

Use prototypal inheritance: Org B creates an agent that references ("inherits from") Org A's published agent.

```
┌─────────────────────────┐         ┌─────────────────────────┐
│ Org A (Publisher)       │         │ Org B (Subscriber)      │
│                         │         │                         │
│  Agent a                │         │  Agent b                │
│  ├─ instructions: "..." │◄────────│  ├─ prototype: {a.id}   │
│  ├─ tools: [...]        │ inherits│  ├─ instructions: "..." │ ← override
│  ├─ model: "gpt-5"      │         │  └─ (tools inherited)   │
│  └─ published: true     │         │                         │
└─────────────────────────┘         └─────────────────────────┘
```

### Type Extension

```typescript
export type AIAgentExtra = {
  // ... existing fields

  // Publisher side
  published?: {
    name: string;
    description: string;
    allow_overrides?: ('instructions' | 'model' | 'temperature')[];
  };

  // Subscriber side
  prototype?: {
    agent_id: string;
  };
};
```

### Config Resolution

At execution time, `agent-client` merges prototype config with local overrides:

```typescript
async function resolveAgentConfig(agent: Agent): Promise<ResolvedAgentExtra> {
  const extra = agent.extra as AIAgentExtra;

  if (!extra.prototype) {
    return extra;
  }

  const prototype = await fetchAgent(extra.prototype.agent_id);

  if (!prototype?.extra?.published) {
    throw new Error("Prototype agent is not published");
  }

  return {
    ...prototype.extra,
    ...omitNulls(extra),
    prototype: undefined,
    published: undefined,
  };
}
```

### Inheritance Rules

| Field | Behavior |
|-------|----------|
| `instructions` | Inherit, can override |
| `tools` | Inherit, can override or extend |
| `model`, `temperature`, etc. | Inherit, can override |
| `api_key`, `api_url` | Inherit (publisher's secrets stay with publisher) |
| `prototype` | Never inherit (no chaining) |
| `published` | Never inherit |
| `mode` | Local only (subscriber controls active/inactive) |

### Benefits

1. **No new tables** - extends existing agent model
2. **Subscriber's agent is real** - passes FK constraints, RLS, existing queries
3. **Natural overrides** - set field to override, omit to inherit
4. **Secrets stay secure** - API keys never leave publisher's config
5. **Automatic updates** - subscribers get improvements immediately

### Data Isolation

- **Conversations/messages**: belong to subscriber, publisher never sees them
- **Agent config**: owned by publisher, read at execution time
- **Tool results**: stored in subscriber's messages

### Open Questions

- **Discovery**: How do subscribers find published agents? Direct link vs marketplace view
- **Tool extension**: Replace subscriber's tools or merge with prototype's?
- **Versioning**: What if publisher breaks something? Pinned versions?
- **Billing**: Usage tracking for revenue share (future)
- **Unpublishing**: Graceful degradation when prototype becomes unavailable

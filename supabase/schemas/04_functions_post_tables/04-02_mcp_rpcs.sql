-- =============================================================================
-- MCP Server RPC: mcp_list_conversations
-- =============================================================================
-- Returns recent active WhatsApp conversations with context for AI agents.
-- Only complex queries that benefit from SQL aggregation go here;
-- simple queries use Supabase client in tools.ts.
--
-- EXAMPLE OUTPUT:
-- [
--   {
--     "name": "John Doe",           -- Contact name (from conversation or contacts table)
--     "phone": "541133525394",      -- Contact's phone number (contact_address)
--     "account_phone": "5492604237115",  -- Only included if org has multiple accounts
--     "unread": 2,                  -- Count of unread incoming messages
--     "last_message": {
--       "direction": "incoming",
--       "content": "Hello!",        -- Text content or "[type]" for non-text
--       "timestamp": "2024-01-15T10:30:00Z",
--       "status": "delivered",      -- From status->>'status'
--       "errors": null              -- From status->'errors', only if present
--     }
--   },
--   ...
-- ]
-- =============================================================================

CREATE OR REPLACE FUNCTION mcp_list_conversations(
  p_org_id uuid,
  p_limit int DEFAULT 10
)
RETURNS TABLE (
  conversation jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_account_count int;
BEGIN
  -- Count connected WhatsApp accounts to decide if we should include account_phone
  -- If org has only 1 account, account_phone is omitted from output (not needed)
  SELECT count(*) INTO v_account_count
  FROM organizations_addresses
  WHERE organization_id = p_org_id 
    AND service = 'whatsapp' 
    AND status = 'connected';

  RETURN QUERY
  SELECT 
    -- Build JSON object for each conversation, stripping null values
    jsonb_strip_nulls(jsonb_build_object(
      
      -- Contact name: prefer conversation.name, fallback to contacts.name, then 'Unknown'
      'name', COALESCE(c.name, con.name, 'Unknown'),
      
      -- Contact phone: the contact's WhatsApp number (stored as contact_address)
      'phone', c.contact_address,
      
      -- Account phone: only include if org has multiple accounts
      -- Looks up the user-facing phone from organizations_addresses.extra->>'phone_number'
      'account_phone', CASE 
        WHEN v_account_count > 1 THEN (
          SELECT COALESCE(oa.extra->>'phone_number', oa.address)
          FROM organizations_addresses oa
          WHERE oa.organization_id = p_org_id 
            AND oa.address = c.organization_address
            AND oa.service = 'whatsapp'
        )
        ELSE NULL 
      END,
      
      -- Last message: subquery gets the most recent message for this conversation
      'last_message', (
        SELECT jsonb_strip_nulls(jsonb_build_object(
          'direction', m.direction,
          
          -- Content extraction: handles both text formats:
          -- 1. Old format: content->'text' is a string
          -- 2. New format: content->'text'->'body' is the text
          -- For non-text messages, shows the type in brackets: [image], [audio], etc.
          'content', CASE 
            WHEN m.content->>'type' = 'text' THEN 
              CASE 
                WHEN jsonb_typeof(m.content->'text') = 'string' THEN m.content->>'text'
                ELSE m.content->'text'->>'body'
              END
            ELSE '[' || (m.content->>'type') || ']'
          END,
          
          'timestamp', m.timestamp,
          'status', m.status->>'status',
          
          -- Errors: only include if present in status object
          'errors', CASE WHEN m.status ? 'errors' THEN m.status->'errors' ELSE NULL END
        ))
        FROM messages m
        WHERE m.conversation_id = c.id
        ORDER BY m.timestamp DESC
        LIMIT 1
      ),
      
      -- Unread count: incoming messages without 'read' status
      'unread', (
        SELECT count(*) 
        FROM messages m 
        WHERE m.conversation_id = c.id 
          AND m.direction = 'incoming' 
          AND (m.status->>'read') IS NULL
      )
    )) as conversation
    
  FROM conversations c
  
  -- LEFT JOIN to contacts to get contact name
  -- Relationship is via JSONB containment: contacts.extra->'addresses' contains the phone
  LEFT JOIN contacts con
    ON con.organization_id = c.organization_id 
    AND (con.extra->'addresses') @> to_jsonb(c.contact_address)
    
  WHERE c.organization_id = p_org_id
    AND c.service = 'whatsapp'
    AND c.status = 'active'
    
  -- Order by most recent message timestamp (newest first)
  ORDER BY (
    SELECT m.timestamp 
    FROM messages m 
    WHERE m.conversation_id = c.id 
    ORDER BY m.timestamp DESC 
    LIMIT 1
  ) DESC NULLS LAST
  
  LIMIT p_limit;
END;
$$;

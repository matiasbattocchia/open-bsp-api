#!/bin/bash

# Script to insert or update vault secrets using environment variables
# This script should be run after database deployment to configure secrets
# Supports both Supabase Cloud and self-hosted deployments

set -e

# Detect deployment type and set variables accordingly
if [ -n "$SUPABASE_DB_URL" ] || [ -n "$SUPABASE_URL" ]; then
    # Self-hosted deployment
    echo "Detected self-hosted Supabase deployment"
    
    # Check required environment variables for self-hosted
    if [ -z "$SUPABASE_DB_URL" ] || [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
        echo "Error: Required environment variables for self-hosted deployment are not set"
        echo "Required: SUPABASE_DB_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY"
        exit 1
    fi
    
    DB_URL="$SUPABASE_DB_URL"
    EDGE_FUNCTIONS_URL="${SUPABASE_URL}/functions/v1"
    
elif [ -n "$SUPABASE_PROJECT_ID" ] || [ -n "$SUPABASE_DB_PASSWORD" ]; then
    # Supabase Cloud deployment
    echo "Detected Supabase Cloud deployment"
    
    # Check required environment variables for cloud
    if [ -z "$SUPABASE_PROJECT_ID" ] || [ -z "$SUPABASE_DB_PASSWORD" ] || [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
        echo "Error: Required environment variables for cloud deployment are not set"
        echo "Required: SUPABASE_PROJECT_ID, SUPABASE_DB_PASSWORD, SUPABASE_SERVICE_ROLE_KEY"
        exit 1
    fi
    
    DB_URL="postgresql://postgres.${SUPABASE_PROJECT_ID}:${SUPABASE_DB_PASSWORD}@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
    EDGE_FUNCTIONS_URL="https://${SUPABASE_PROJECT_ID}.supabase.co/functions/v1"
    
else
    echo "Error: Cannot determine deployment type"
    echo "For self-hosted: Set SUPABASE_DB_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY"
    echo "For cloud: Set SUPABASE_PROJECT_ID, SUPABASE_DB_PASSWORD, SUPABASE_SERVICE_ROLE_KEY"
    exit 1
fi

echo "Updating vault secrets..."

# SQL to upsert secrets (insert or update if exists)
psql "$DB_URL" << EOF
-- Upsert edge_functions_url secret
DO \$\$
BEGIN
    IF EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'edge_functions_url') THEN
        -- Update existing secret
        PERFORM vault.update_secret(
            (SELECT id FROM vault.decrypted_secrets WHERE name = 'edge_functions_url'),
            '$EDGE_FUNCTIONS_URL',
            'edge_functions_url',
            'Edge Functions base URL'
        );
        RAISE NOTICE 'Updated edge_functions_url secret';
    ELSE
        -- Create new secret
        PERFORM vault.create_secret(
            '$EDGE_FUNCTIONS_URL',
            'edge_functions_url',
            'Edge Functions base URL'
        );
        RAISE NOTICE 'Created edge_functions_url secret';
    END IF;
END
\$\$;

-- Upsert edge_functions_token secret
DO \$\$
BEGIN
    IF EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'edge_functions_token') THEN
        -- Update existing secret
        PERFORM vault.update_secret(
            (SELECT id FROM vault.decrypted_secrets WHERE name = 'edge_functions_token'),
            '$SUPABASE_SERVICE_ROLE_KEY',
            'edge_functions_token',
            'Service role key'
        );
        RAISE NOTICE 'Updated edge_functions_token secret';
    ELSE
        -- Create new secret
        PERFORM vault.create_secret(
            '$SUPABASE_SERVICE_ROLE_KEY',
            'edge_functions_token',
            'Service role key'
        );
        RAISE NOTICE 'Created edge_functions_token secret';
    END IF;
END
\$\$;
EOF

echo "Vault secrets updated successfully!"
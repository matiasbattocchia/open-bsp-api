#!/bin/bash

set -e

echo "Finding Supabase functions pod..."
POD_NAME=$(kubectl get pod -l app.kubernetes.io/name=supabase-functions -n supa -o jsonpath='{.items[0].metadata.name}')

if [ -z "$POD_NAME" ]; then
    echo "Error: No pod found"
    kubectl get pod -l app.kubernetes.io/name=supabase-functions -n supa
    exit 1
fi

echo "Found pod: $POD_NAME"
echo "Copying functions to pod..."
kubectl cp ./supabase/functions/. supa/$POD_NAME:/home/deno/functions

echo "Finding Supabase functions deployment..."
# Get deployment name from the pod's owner reference
REPLICASET_NAME=$(kubectl get pod $POD_NAME -n supa -o jsonpath='{.metadata.ownerReferences[?(@.kind=="ReplicaSet")].name}')
DEPLOYMENT_NAME=$(echo $REPLICASET_NAME | sed 's/-[^-]*$//')

if [ -z "$DEPLOYMENT_NAME" ]; then
    echo "Warning: Could not determine deployment name, skipping restart"
else
    echo "Found deployment: $DEPLOYMENT_NAME"
    echo "Restarting deployment..."
    kubectl rollout restart deployment/$DEPLOYMENT_NAME -n supa
fi

echo "Deployment complete!"

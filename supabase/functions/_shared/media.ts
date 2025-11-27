import ky from "ky";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decodeBase64 } from "jsr:@std/encoding/base64";
import { encodeBase64Url } from "jsr:@std/encoding/base64url";

const SIGNED_URL_EXPIRATION_SECONDS = 3600; // 1 hour
const BASE_URI = "internal://media";

export async function fetchMedia(url: string, token?: string) {
  return await ky(url, {
    method: "GET",
    headers: {
      ...(token && {
        Authorization: `Bearer ${token}`,
      }),
    },
  }).blob();
}

export function base64ToBlob(base64: string, mime_type?: string) {
  const buffer = decodeBase64(base64);
  return new Blob([buffer], { type: mime_type || "application/octet-stream" });
}

export async function uploadToStorage(
  client: SupabaseClient,
  organization_id: string,
  file: Blob,
  name?: string,
) {
  // Use a hash of the file contents as the file id to help with deduplication
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const file_hash = encodeBase64Url(hashBuffer);

  const key = `/organizations/${organization_id}/attachments/${file_hash}`;

  const { error } = await client.storage.from("media").upload(key, file, {
    upsert: true,
    metadata: { name },
  });

  if (error) {
    throw error;
  }

  return BASE_URI + key;
}

export async function downloadFromStorage(client: SupabaseClient, uri: string) {
  // Extract the storage key from the internal uri format
  // Example: "internal://media/org/contact/file" -> "org/contact/file"
  const key = uri.replace(BASE_URI, "");

  const { data, error } = await client.storage.from("media").download(key);

  if (error) {
    throw error;
  }

  return data;
}

export async function createSignedUrl(client: SupabaseClient, uri: string) {
  const key = uri.replace(BASE_URI, "");

  const { data, error } = await client.storage
    .from("media")
    .createSignedUrl(key, SIGNED_URL_EXPIRATION_SECONDS);

  if (error) {
    throw error;
  }

  return data.signedUrl;
}

export async function getFileMetadata(client: SupabaseClient, uri: string) {
  const key = uri.replace(BASE_URI + "/", "");

  const { data } = await client
    .schema("storage")
    .from("objects")
    .select("name, metadata, user_metadata")
    .eq("name", key)
    .eq("bucket_id", "media")
    .single()
    .throwOnError();

  return {
    mime_type: data.metadata.mimetype as string,
    uri,
    name: data.user_metadata?.name as string | undefined,
    size: data.metadata.size as number,
  };
}

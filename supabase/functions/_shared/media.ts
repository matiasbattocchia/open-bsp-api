import ky from "ky";
import type { ConversationRow } from "./supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

const SIGNED_URL_EXPIRATION_SECONDS = 3600; // 1 hour

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

export async function uploadToStorage(
  client: SupabaseClient,
  conv: ConversationRow,
  file: Uint8Array | Blob,
  mime_type?: string // Required for Uint8Array!
) {
  if (!(file instanceof Blob) && !mime_type) {
    throw new Error("mime_type is required when file is not a Blob");
  }

  const media_id = crypto.randomUUID();

  const key = `${conv.organization_address}/${conv.contact_address}/${media_id}`;

  const { error } = await client.storage.from("media").upload(key, file, {
    upsert: true,
    ...(mime_type && { contentType: mime_type }),
    //metadata: {}
  });

  if (error) {
    throw error;
  }

  return "internal://media/" + key;
}

export async function downloadFromStorage(client: SupabaseClient, uri: string) {
  // Extract the storage key from the internal uri format
  // Example: "internal://media/org/contact/file" -> "org/contact/file"
  const key = uri.replace("internal://media/", "");

  const { data, error } = await client.storage.from("media").download(key);

  if (error) {
    throw error;
  }

  return data;
}

export async function createSignedUrl(client: SupabaseClient, uri: string) {
  const key = uri.replace("internal://media/", "");

  const { data, error } = await client.storage
    .from("media")
    .createSignedUrl(key, SIGNED_URL_EXPIRATION_SECONDS);

  if (error) {
    throw error;
  }

  return data.signedUrl;
}

import ky from "ky";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decodeBase64 } from "jsr:@std/encoding/base64";
import { encodeBase64Url } from "jsr:@std/encoding/base64url";
import type { MessageInsert } from "./types/database_types.ts";
import type { IncomingMessage } from "./types/message_types.ts";
import type { IncomingStatus } from "./types/status_types.ts";

const SIGNED_URL_EXPIRATION_SECONDS = 3600; // 1 hour
const BASE_URI = "internal://media";

export const MAX_STORAGE_UPLOAD_SIZE = parseInt(
  Deno.env.get("MAX_STORAGE_UPLOAD_SIZE") || String(50 * 1000 * 1000),
); // 50 MB default (Supabase free tier)

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
  // @ts-ignore: Uint8Array<ArrayBufferLike> is valid as BlobPart at runtime
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

/**
 * What an inbound medium becomes when its bytes could not be stored — a failed
 * download, a file over the upload limit, a full storage quota: a
 * media_placeholder, the shape the Cloud API itself sends for media it cannot
 * hand over. Every service that downloads media degrades this way, so a
 * FilePart always means stored bytes.
 *
 * Everything else the message said survives (caption, mentions, reply
 * context), and so does what is known about the medium: `file` minus the
 * `uri`, which held the service's own reference and is the one thing missing.
 *
 * The reason goes in `status.errors`, merged into the status the row already
 * states, so the writer's arming decision survives the failure — a history
 * replay's `pending: null`, Slack's explicit `pending`. A row that stated none
 * ends up stating one, which leaves it unarmed, as the bridge's are.
 */
export function withoutMedia(
  message: MessageInsert,
  reason: string,
): MessageInsert {
  if (message.content.type !== "file") {
    return message;
  }

  const {
    type: _type,
    kind: _kind,
    file: { uri: _uri, ...file },
    ...rest
  } = message.content;

  return {
    ...message,
    content: {
      ...rest,
      type: "data",
      kind: "media_placeholder",
      data: {},
      file,
    } as IncomingMessage,
    status: {
      ...message.status,
      errors: [reason],
    } as IncomingStatus,
  };
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

// Extension → mime, for external URLs only. Deliberately small: its one job
// is steering the media KIND (audio/image/video, else document) that callers
// derive from the mime prefix — dispatchers pick the send endpoint by kind.
const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  "3gp": "video/3gpp",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/opus",
  amr: "audio/amr",
  wav: "audio/wav",
  pdf: "application/pdf",
};

/**
 * External (http/https) URIs are first-class file references and are never
 * touched: the WhatsApp and Instagram dispatchers send them as `link` — the
 * receiving service fetches the URL itself. Metadata is derived from the URL
 * string alone; an unknown extension means octet-stream, i.e. kind
 * `document`.
 */
export function getExternalFileMetadata(uri: string) {
  const name = new URL(uri).pathname.split("/").pop() || undefined;
  const extension = name?.split(".").pop()?.toLowerCase();

  return {
    mime_type: (extension && MIME_BY_EXTENSION[extension]) ||
      "application/octet-stream",
    uri,
    name,
    size: undefined as number | undefined,
  };
}

export async function getFileMetadata(client: SupabaseClient, uri: string) {
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    return getExternalFileMetadata(uri);
  }

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

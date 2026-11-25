import ky from "ky";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decodeBase64 } from "jsr:@std/encoding/base64";
import { encodeBase64Url } from "jsr:@std/encoding/base64url";
import { isQuotaError } from "./connections.ts";
import * as log from "./logger.ts";
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

// A cover a browser can show; one in another format is left out.
const THUMBNAIL_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

const MAX_THUMBNAIL_SIZE = 5 * 1000 * 1000;

/**
 * A post's cover, as an internal uri: stored once per post. The services link
 * it at a URL that expires, so the first comment on a post keeps a copy, named
 * after the post, and the ones after it find that copy. Best effort: undefined
 * when there is no cover to keep (no link, or not an image a browser shows)
 * or it could not be stored, and the comment goes without one.
 */
export async function storePostThumbnail(
  client: SupabaseClient,
  organization_id: string,
  service: "instagram" | "tiktok",
  item_id: string,
  url: string | undefined,
): Promise<string | undefined> {
  const key =
    `organizations/${organization_id}/attachments/${service}-post-${item_id}`;
  const details = { organization_id, service, item_id };

  try {
    const { data: stored } = await client
      .schema("storage")
      .from("objects")
      .select("name")
      .eq("bucket_id", "media")
      .eq("name", key)
      .maybeSingle()
      .throwOnError();

    if (stored) return `${BASE_URI}/${key}`;
    if (!url) return;

    // The headers decide before the body is read: a cover that is a video
    // is not downloaded at all.
    const response = await fetch(url);
    const type = response.headers.get("content-type")?.split(";")[0].trim();
    const length = Number(response.headers.get("content-length") ?? 0);

    if (!response.ok) {
      await response.body?.cancel();
      log.warn("Could not download a post's cover", {
        ...details,
        status: response.status,
      });
      return;
    }

    if (!type || !THUMBNAIL_TYPES.has(type) || length > MAX_THUMBNAIL_SIZE) {
      await response.body?.cancel();
      log.info("A post's cover is not an image to keep", {
        ...details,
        type,
        length,
      });
      return;
    }

    const file = await response.blob();
    if (file.size > MAX_THUMBNAIL_SIZE) return;

    const { error } = await client.storage.from("media").upload(key, file, {
      contentType: type,
      upsert: true,
    });

    if (error) throw error;

    return `${BASE_URI}/${key}`;
  } catch (error) {
    logUnstored("A post's cover was not stored", error, details);
  }
}

/**
 * Logs why a medium's bytes were not stored. A full storage quota is the plan
 * at work, which the organization hears of by email, so it logs as info;
 * anything else (a failed download, the service refusing) may need a look.
 */
export function logUnstored(
  message: string,
  error: unknown,
  details: Record<string, unknown>,
) {
  (isQuotaError(error) ? log.info : log.warn)(message, {
    error: error instanceof Error ? error.message : String(error),
    ...details,
  });
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

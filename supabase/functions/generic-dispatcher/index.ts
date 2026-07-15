// Generic dispatcher for connector-based services (self-hosted bridges such
// as the whatsmeow one). Where the Meta dispatchers adapt OpenBSP messages to
// the Graph API dialect, a connector adapts to OpenBSP: the message row is
// forwarded as-is and the connector translates it to its own protocol.
//
// The dispatcher trigger/cron routes by naming convention
// (`/{service}-dispatcher`), so each connector service is registered in
// config.toml as its own slug pointing at THIS entrypoint; the service is
// derived from the slug. Adding a connector = a config.toml block + an env
// case in connectorConfig().
//
// Contract (single endpoint on the connector, bearer-authenticated):
//
//   POST {url}/dispatch  { type: "message", record: MessageRow, media_url? }
//     → 2xx { external_id: string, status?: "sent" | "accepted" }
//     → 4xx permanent failure (message marked failed, no retry)
//     → 5xx transient failure (kept pending, retried by the dispatch cron)
//
//   POST {url}/dispatch  { type: "status", record: MessageRow }
//     read receipt / typing indicator for an incoming message; response body
//     is ignored.
//
// `media_url` is a short-lived signed download URL for `content.file.uri`
// (`internal://media/...`) so the connector never needs storage credentials.
import * as log from "../_shared/logger.ts";
import {
  createUnsecureClient,
  type MessageRow,
  type WebhookPayload,
} from "../_shared/supabase.ts";
import { createSignedUrl } from "../_shared/media.ts";
import { commitDispatchedMessage } from "../_shared/dispatch.ts";
import type { Json } from "../_shared/db_types.ts";

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Derives the service from the function slug (e.g. /whatsapp-web-dispatcher)
 * or, when invoked under the generic slug, from the subpath
 * (/generic-dispatcher/whatsapp-web). */
function serviceFromRequest(req: Request): string {
  const segments = new URL(req.url).pathname.split("/").filter(Boolean);
  const slug = segments[0] ?? "";
  if (slug === "generic-dispatcher") return segments[1] ?? "";
  return slug.replace(/-dispatcher$/, "");
}

/** Per-service connector location: <SERVICE>_URL is the bridge base URL,
 * <SERVICE>_TOKEN the shared bearer used in both directions. */
function connectorConfig(
  service: string,
): { url: string; token: string } | null {
  if (service === "whatsapp-web") {
    return {
      url: Deno.env.get("WHATSAPP_WEB_URL") ?? "",
      token: Deno.env.get("WHATSAPP_WEB_TOKEN") ?? "",
    };
  }
  return null;
}

class ConnectorError extends Error {
  transient: boolean;

  constructor(message: string, transient: boolean) {
    super(message);
    this.name = "ConnectorError";
    this.transient = transient;
  }
}

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (token !== SERVICE_ROLE_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const service = serviceFromRequest(req);
  const connector = connectorConfig(service);

  if (!connector || !connector.url) {
    throw new Error(`No connector configured for service '${service}'`);
  }

  const client = createUnsecureClient();
  const message = ((await req.json()) as WebhookPayload<MessageRow>).record!;

  log.info(`Dispatching message ${message.id} to ${service} connector`, {
    message_id: message.id,
    service,
  });

  const postToConnector = async (body: Json): Promise<Response> => {
    return await fetch(`${connector.url}/dispatch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connector.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  };

  if (message.direction === "outgoing") {
    try {
      // Hand the connector a signed download URL for internal media so it
      // can fetch the bytes with a plain GET.
      let media_url: string | undefined;
      if (
        message.content.type === "file" &&
        message.content.file.uri.startsWith("internal://")
      ) {
        media_url = await createSignedUrl(client, message.content.file.uri);
      }

      const response = await postToConnector({
        type: "message",
        record: message as unknown as Json,
        ...(media_url && { media_url }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const transient = response.status >= 500;
        throw new ConnectorError(
          `Connector responded ${response.status}: ${body}`,
          transient,
        );
      }

      const result = (await response.json()) as {
        external_id?: string;
        status?: string;
      };

      await commitDispatchedMessage({
        client,
        messageId: message.id,
        externalId: result.external_id,
        status: { [result.status || "sent"]: new Date().toISOString() },
      });
    } catch (error) {
      // Network failures (connector down/unreachable) are transient.
      const transient = !(error instanceof ConnectorError) || error.transient;
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);

      if (transient) {
        // Record the error for user visibility but keep retryable (no
        // "failed" key); the dispatch cron re-fires pending messages.
        log.warn("Connector dispatch failed (transient, will retry)", {
          message_id: message.id,
          error: errorMessage,
        });

        await client
          .from("messages")
          .update({ status: { errors: [errorMessage] } })
          .eq("id", message.id)
          .throwOnError();

        throw error;
      }

      log.error("Connector dispatch failed (permanent)", {
        message_id: message.id,
        error: errorMessage,
      });

      await client
        .from("messages")
        .update({
          status: {
            failed: new Date().toISOString(),
            errors: [errorMessage],
          },
        })
        .eq("id", message.id)
        .throwOnError();
    }
  } else if (message.direction === "incoming") {
    // Read receipt / typing indicator, mirroring whatsapp-dispatcher's
    // recency window.
    const recent = (ts: string | undefined) =>
      !!ts && Date.now() - +new Date(ts) <= 60 * 1000;

    const status = message.status as Record<string, string | undefined>;
    if (!recent(status.read) && !recent(status.typing)) {
      return new Response();
    }

    if (!message.external_id) {
      throw new Error(
        `Cannot send receipt for message ${message.id}: external_id is missing`,
      );
    }

    const response = await postToConnector({
      type: "status",
      record: message as unknown as Json,
    });

    if (!response.ok) {
      throw new Error(
        `Connector responded ${response.status} to status forward`,
      );
    }
  } else {
    throw new Error(
      `Cannot dispatch message ${message.id}: direction is not 'outgoing' nor 'incoming'`,
    );
  }

  return new Response();
});

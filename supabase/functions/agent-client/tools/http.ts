/**
 * Fetch tool
 *
 * {
 *   "provider": "local",
 *   "type": "fetch",
 *   "client_label": "my_client",
 *   "headers": {
 *     "Authorization": "Bearer 1234567890",
 *     "X-Organization-Address": "$context.conversation.organization_address"
 *   }
 * }
 *
 * This tool inherits from the base Fetch tool. It makes tools based on HTTP requests.
 *
 * {
 *   "client_label": "my_client",
 *   "name": "create_user",
 *   "description": "Create a user",
 *   "input": {
 *     "type": "object",
 *     "properties": {
 *       "organization_id": { "type": "string" },
 *       "user_name": { "type": "string" }
 *     },
 *     "required": ["organization_id", "user_name"]
 *   },
 *   "request": {
 *     "url": "https://api.example.com/organizations/$input.organization_id/users",
 *     "method": "POST",
 *     "headers": {
 *       "Authorization": "Bearer 1234567890",
 *       "X-Contact-Address": "$context.conversation.contact_address"
 *     },
 *     "body": {
 *       "name": "$input.user_name"
 *     }
 *   }
 * }
 */

import * as z from "zod";
import ky from "ky";
import { contextHeaders, type RequestContext } from "../protocols/base.ts";
import type { LocalHTTPToolConfig } from "../../_shared/supabase.ts";
import type { ToolDefinition } from "./base.ts";

export const RequestToolInputSchema = z.object({
  url: z.string().describe("The request URL"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  headers: z.record(z.string(), z.string()).optional(),
  body: z
    .looseObject({})
    .optional()
    .describe("JSON payload. If present, the correct header will be set."),
});

export const RequestToolOutputSchema = z.union([
  z.object({
    status: z.number(),
    isError: z.literal(true),
    message: z.string(),
  }),
  z.object({
    status: z.number(),
    isError: z.literal(false),
    body: z.looseObject({}),
  }),
]);

/**
 * Strict URL allow-list check.
 *
 * Returns `true` only when `inputUrl` resolves to a URL whose host matches
 * `configUrl`'s host exactly, whose scheme is http(s), whose userinfo is
 * empty, and whose path either matches `configUrl`'s path exactly (no
 * wildcard) or extends it on a `/` path-boundary (wildcard `configUrl`
 * ends in `/*`).
 *
 * Replaces a previous `startsWith(baseUrl)` check that allowed:
 *   - host-suffix confusion (`api.acme.com.evil.com`)
 *   - userinfo trick        (`api.acme.com@evil.com`)
 *   - path-boundary escape  (`/public/*` matched `/public-admin/...`)
 */
function isUrlAllowed(configUrl: string, inputUrl: string): boolean {
  const isWildcard = configUrl.endsWith("/*");
  let cfg: URL;
  let inp: URL;
  try {
    cfg = new URL(isWildcard ? configUrl.slice(0, -2) : configUrl);
    inp = new URL(inputUrl);
  } catch {
    return false;
  }

  if (inp.protocol !== "https:" && inp.protocol !== "http:") {
    return false;
  }
  if (inp.username !== "" || inp.password !== "") {
    return false;
  }
  if (inp.host !== cfg.host) {
    return false;
  }

  if (!isWildcard) {
    return inp.pathname === cfg.pathname && inp.search === cfg.search;
  }

  // Wildcard: require exact path-prefix on a `/` boundary.
  const base = cfg.pathname.endsWith("/") ? cfg.pathname : cfg.pathname + "/";
  return (
    inp.pathname === cfg.pathname.replace(/\/$/, "") ||
    inp.pathname.startsWith(base)
  );
}

export async function requestToolImplementation(
  input: z.infer<typeof RequestToolInputSchema>,
  config: LocalHTTPToolConfig["config"],
  context: RequestContext,
): Promise<z.infer<typeof RequestToolOutputSchema>> {
  // TODO: $context.conversation.contact_address value-like replacement

  // Security check: URL restriction
  if (config.url) {
    if (!isUrlAllowed(config.url, input.url)) {
      return {
        status: 403,
        isError: true,
        message: `URL not allowed by tool config (${config.url}).`,
      };
    }
  }

  // Security check: Method restriction
  if (config.methods && config.methods.length > 0) {
    if (!config.methods.includes(input.method)) {
      return {
        status: 403,
        isError: true,
        message: `Method ${input.method} not allowed. Allowed: ${
          config.methods.join(", ")
        }`,
      };
    }
  }

  const response = await ky(input.url, {
    method: input.method,
    headers: {
      ...contextHeaders(context),
      ...input.headers,
      ...config.headers,
    },
    json: input.body,
  });

  if (!response.ok) {
    return {
      status: response.status,
      isError: true,
      message: await response.text(),
    };
  }

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { text };
  }

  return {
    status: response.status,
    isError: false,
    body,
  };
}

export const RequestTool: ToolDefinition<
  typeof RequestToolInputSchema,
  typeof RequestToolOutputSchema,
  LocalHTTPToolConfig["config"]
> = {
  provider: "local",
  type: "http",
  name: "request",
  description: "HTTP client. Works with JSON payloads only.",
  inputSchema: z.toJSONSchema(RequestToolInputSchema),
  outputSchema: z.toJSONSchema(RequestToolOutputSchema),
  implementation: requestToolImplementation,
};

export const HTTPTools = [RequestTool];

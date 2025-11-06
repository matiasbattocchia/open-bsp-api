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
import type { RequestContext } from "../protocols/base.ts";
import type { LocalHTTPToolConfig } from "../../_shared/supabase.ts";
import type { ToolDefinition } from "./base.ts";

export const RequestToolInputSchema = z.object({
  url: z.url(),
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

export async function requestToolImplementation(
  input: z.infer<typeof RequestToolInputSchema>,
  config: LocalHTTPToolConfig["config"],
  _context: RequestContext,
): Promise<z.infer<typeof RequestToolOutputSchema>> {
  // TODO: $context.conversation.contact_address value-like replacement

  const response = await ky(input.url, {
    method: input.method,
    headers: { ...input.headers, ...config.headers },
    json: input.body,
  });

  if (!response.ok) {
    return {
      status: response.status,
      isError: true,
      message: await response.text(),
    };
  }

  return {
    status: response.status,
    isError: false,
    body: await response.json(),
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

/**
 * The permission mode: what Claude may do beyond reading. Shared by the MCP
 * server and the hooks module (hooks/register.ts), so it imports nothing:
 * the hooks module runs without Node.
 */

export type Permission = "read" | "ask" | "allow";

const ORDER: Permission[] = ["read", "ask", "allow"];

/** A stored or passed-in mode; anything else is the default, ask. */
export function parsePermission(value: unknown): Permission {
  return ORDER.includes(value as Permission) ? value as Permission : "ask";
}

/** Whether `a` lets Claude do more than `b`. */
export function looser(a: Permission, b: Permission): boolean {
  return ORDER.indexOf(a) > ORDER.indexOf(b);
}

/** For the instructions: how the mode bears on replying. */
export const PERMISSION_NOTES: Record<Permission, string> = {
  read:
    "Permission mode: read only — the reply tool and every change are refused. Summarize, and draft answers in chat if the user wants them.",
  ask:
    "Permission mode: ask — Claude Code asks the user to approve each reply and each change, showing what it sends. Don't also ask in chat.",
  allow: "Permission mode: allow — a reply goes out as soon as you send it.",
};

// Reads sent with another method: the template list takes a body.
const READS = [["PUT", "/functions/v1/whatsapp-management/templates"]];

/** Whether a query changes something (anything but a read). */
export function isChange(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  const route = path.split("?")[0];
  return !READS.some(([m, p]) => m === method && p === route);
}

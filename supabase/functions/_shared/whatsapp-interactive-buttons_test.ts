import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { buildOutgoingButtonsMessage } from "./whatsapp-interactive-buttons.ts";

Deno.test("buildOutgoingButtonsMessage: reply buttons unchanged", () => {
  const payload = buildOutgoingButtonsMessage({
    body: "Pick one",
    buttons: [
      { id: "yes", title: "Yes" },
      { id: "no", title: "No" },
    ],
  });
  assertEquals(payload.interactive.type, "button");
  if (payload.interactive.type !== "button") return;
  assertEquals(payload.interactive.action.buttons.length, 2);
  assertEquals(payload.interactive.action.buttons[0].reply.id, "yes");
});

Deno.test("buildOutgoingButtonsMessage: website button maps to cta_url", () => {
  const payload = buildOutgoingButtonsMessage({
    body: "Visit our site",
    buttons: [{
      type: "website",
      title: "Open site",
      url: "https://example.com/path",
    }],
  });
  assertEquals(payload.interactive.type, "cta_url");
  if (payload.interactive.type !== "cta_url") return;
  assertEquals(payload.interactive.action.name, "cta_url");
  assertEquals(
    payload.interactive.action.parameters.display_text,
    "Open site",
  );
  assertEquals(
    payload.interactive.action.parameters.url,
    "https://example.com/path",
  );
});

Deno.test("buildOutgoingButtonsMessage: rejects mixed button types", () => {
  assertThrows(
    () =>
      buildOutgoingButtonsMessage({
        body: "Mixed",
        buttons: [
          { id: "a", title: "Reply" },
          { type: "website", title: "Site", url: "https://example.com" },
        ],
      }),
    Error,
    "cannot mix reply and website",
  );
});

Deno.test("buildOutgoingButtonsMessage: website requires single button", () => {
  assertThrows(
    () =>
      buildOutgoingButtonsMessage({
        body: "Two sites",
        buttons: [
          { type: "website", title: "A", url: "https://a.example" },
          { type: "website", title: "B", url: "https://b.example" },
        ],
      }),
    Error,
    "exactly one button",
  );
});

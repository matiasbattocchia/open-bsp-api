/**
 * First run, in TUI menus: sign in, create or join an organization, connect
 * accounts, choose how Claude answers messages and how often it checks. Each
 * step also runs on its own, contacts (the allowlist) among them.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { callFunction } from "./api.ts";
import { type AnswerMode, loadConfig, updateConfig } from "./config.ts";
import {
  ask,
  type Choice,
  choose,
  form,
  poll,
  type Ui,
  waitFor,
} from "./menus.ts";
import { normalizeAddress, sameAddress } from "./messages.ts";
import {
  acceptInvitation,
  accountLabel,
  createOrg,
  listInvitations,
  listOrgs,
  type Org,
  resolveAccounts,
} from "./org.ts";

export const STEPS = [
  "organization",
  "accounts",
  "contacts",
  "answering",
  "checking",
] as const;

export type Step = typeof STEPS[number];

// The allowlist is for the channel and group chats: the inbox reads every
// one-to-one conversation without it, so a first setup skips it.
const FIRST_RUN: Step[] = ["organization", "accounts", "answering", "checking"];

export type SetupContext = {
  ui: Ui;
  supabase: SupabaseClient;
  /** Signs in when needed; the signed-in user. */
  signIn: () => Promise<string>;
  org: () => Org | null;
  /** Work in this organization from now on. */
  useOrg: (orgId: string) => Promise<void>;
};

// A step's line for the summary, or null when the user dismissed a menu,
// which ends the setup there.
type Runner = (ctx: SetupContext, explicit: boolean) => Promise<string | null>;

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// ── Organization ────────────────────────────────────────────────────────

async function organizationStep(
  ctx: SetupContext,
  explicit: boolean,
): Promise<string | null> {
  const [orgs, invitations] = await Promise.all([
    listOrgs(ctx.supabase),
    listInvitations(ctx.supabase),
  ]);
  const current = ctx.org();

  // Nothing to decide: the only organization, no invitation.
  if (!explicit && current && orgs.length === 1 && invitations.length === 0) {
    return `Organization: ${current.orgName}.`;
  }

  let pick = "new";
  if (orgs.length > 0 || invitations.length > 0) {
    const choices: Choice[] = [
      ...orgs.map((o) => ({
        value: `org:${o.orgId}`,
        title: o.orgId === current?.orgId
          ? `${o.orgName} (current)`
          : o.orgName,
      })),
      ...invitations.map((i) => ({
        value: `invitation:${i.id}`,
        title: `Join ${i.organization_name ?? "an organization"}${
          i.invited_by_name ? `, invited by ${i.invited_by_name}` : ""
        }`,
      })),
      { value: "new", title: "Create a new organization" },
    ];

    const picked = await choose(
      ctx.ui,
      orgs.length > 0
        ? "Which organization should Claude work in?"
        : "You've been invited to an organization. Join it, or create your own.",
      choices,
      {
        title: "Organization",
        preselected: current ? `org:${current.orgId}` : undefined,
      },
    );
    if (!picked) return null;
    pick = picked;
  }

  if (pick.startsWith("org:")) {
    const org = orgs.find((o) => `org:${o.orgId}` === pick)!;
    if (org.orgId !== current?.orgId) await ctx.useOrg(org.orgId);
    return `Organization: ${org.orgName}.`;
  }

  if (pick.startsWith("invitation:")) {
    const invitation = invitations.find((i) => `invitation:${i.id}` === pick)!;
    await ctx.useOrg(await acceptInvitation(ctx.supabase, invitation));
    return `Organization: joined ${invitation.organization_name ?? "it"}.`;
  }

  const {
    data: { user },
  } = await ctx.supabase.auth.getUser();
  const name = await ask(
    ctx.ui,
    "Create your organization. It holds your connected accounts, your conversations and your team.",
    {
      title: "Organization name",
      default: user?.user_metadata?.full_name ?? "",
    },
  );
  if (!name) return null;

  await ctx.useOrg(await createOrg(ctx.supabase, name));
  return `Organization: created ${name}.`;
}

// ── Accounts ────────────────────────────────────────────────────────────

type Connectable = "whatsapp" | "whatsapp-web" | "instagram" | "tiktok";

const SERVICES: { value: Connectable; title: string }[] = [
  {
    value: "whatsapp",
    title: "WhatsApp Business (official API, through Meta)",
  },
  {
    value: "whatsapp-web",
    title: "WhatsApp, linked as a device like WhatsApp Web",
  },
  { value: "instagram", title: "Instagram (professional account)" },
  { value: "tiktok", title: "TikTok (business account)" },
];

const SERVICE_NAMES: Record<Connectable, string> = {
  whatsapp: "WhatsApp Business",
  "whatsapp-web": "WhatsApp",
  instagram: "Instagram",
  tiktok: "TikTok",
};

/**
 * WhatsApp Business, Instagram and TikTok connect through an onboarding link:
 * the provider's own sign-in, on an OpenBSP page that needs no session.
 */
async function connectWithLink(
  ctx: SetupContext,
  org: Org,
  service: Exclude<Connectable, "whatsapp-web">,
): Promise<string> {
  const { data: token } = await ctx.supabase
    .from("onboarding_tokens")
    .insert({
      name: "Claude Code",
      organization_id: org.orgId,
      service,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    .select("id")
    .single()
    .throwOnError();

  const ac = new AbortController();
  const signal = ctx.ui.signal
    ? AbortSignal.any([ac.signal, ctx.ui.signal])
    : ac.signal;
  try {
    await waitFor(ctx.ui, {
      message: `Connect your ${
        SERVICE_NAMES[service]
      } account in the browser. This closes by itself once it's connected.`,
      url: `${loadConfig().appUrl}/onboard/${service}/${token.id}`,
      // The link is marked used once the account is connected.
      done: poll(
        async () => {
          const { data } = await ctx.supabase
            .from("onboarding_tokens")
            .select("status")
            .eq("id", token.id)
            .maybeSingle();
          return data?.status === "used" ? true : undefined;
        },
        signal,
        60 * 60 * 1000,
      ),
      cancel: () => ac.abort(),
    });
  } catch (err) {
    ac.abort();
    await ctx.supabase.from("onboarding_tokens").delete().eq("id", token.id);
    throw err;
  }

  const { data: account } = await ctx.supabase
    .from("organizations_addresses")
    .select("address, extra")
    .eq("organization_id", org.orgId)
    .eq("service", service)
    .eq("status", "connected")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return `${service} ${
    account ? accountLabel(account.address, account.extra) : ""
  }`.trim();
}

type Pairing = {
  session_id: string;
  status: "pending" | "paired" | "error";
  pairing_code?: string;
  address?: string;
  error?: string;
};

/**
 * WhatsApp linked as a device: the user types a pairing code on their phone.
 * An admin links the organization's shared number; a member, their own.
 */
async function linkWhatsAppWeb(
  ctx: SetupContext,
  org: Org,
): Promise<string | null> {
  const phone = await ask(
    ctx.ui,
    "Link your WhatsApp as a device, the way WhatsApp Web does: you'll type a code on your phone. Note that WhatsApp's terms don't allow this, and the number could be banned.",
    {
      title: "Phone number",
      description: "With the country code, e.g. +54 9 11 5555 1234",
    },
  );
  if (!phone) return null;

  let pairing = await callFunction<Pairing>(
    ctx.supabase,
    "POST",
    "whatsapp-web-management/sessions",
    {
      organization_id: org.orgId,
      phone_number: phone.replace(/\D/g, ""),
      ...(org.role === "member" ? { agent_id: org.agentId } : {}),
    },
  );

  const ac = new AbortController();
  const signal = ctx.ui.signal
    ? AbortSignal.any([ac.signal, ctx.ui.signal])
    : ac.signal;
  const pending = () =>
    callFunction<Pairing>(
      ctx.supabase,
      "GET",
      // The organization, for the role check.
      `whatsapp-web-management/sessions/pending/${pairing.session_id}?organization_id=${org.orgId}`,
    );

  if (!pairing.pairing_code) {
    pairing = await poll(
      async () => {
        const p = await pending();
        if (p.status === "error") throw new Error(p.error ?? "pairing failed");
        return p.pairing_code ? p : undefined;
      },
      signal,
      30_000,
      1000,
    );
  }

  const address = await waitFor(ctx.ui, {
    // Two lines: the TUI folds a longer message away.
    message: [
      `Type the code ${pairing.pairing_code} on your phone.`,
      "WhatsApp › Settings › Linked devices › Link a device › Link with phone number instead. This closes by itself once it's linked.",
    ].join("\n"),
    done: poll(
      async () => {
        const p = await pending();
        if (p.status === "error") throw new Error(p.error ?? "pairing failed");
        return p.status === "paired" ? p.address ?? "" : undefined;
      },
      signal,
      10 * 60 * 1000,
    ),
    cancel: () => ac.abort(),
  }).finally(() => ac.abort());

  return `whatsapp-web +${address}`;
}

async function accountsStep(ctx: SetupContext): Promise<string | null> {
  const org = ctx.org();
  if (!org) return "Accounts: skipped, no organization.";

  // Onboarding links are admin+; a member links their own WhatsApp only.
  const services = org.role === "member"
    ? SERVICES.filter((s) => s.value === "whatsapp-web")
    : SERVICES;

  let notice = "";
  while (true) {
    const accounts = await resolveAccounts(ctx.supabase, org.orgId);
    const list = [...accounts.values()]
      .map((a) => `${a.service} ${a.label}`)
      .join(", ");

    const pick = await choose(
      ctx.ui,
      // Two lines: the TUI folds a longer message away.
      [
        notice,
        list
          ? `Connected: ${list}. Connect another one, or continue.`
          : "Connect the accounts whose messages Claude will read and answer.",
      ].filter(Boolean).join("\n"),
      [
        ...services,
        { value: "continue", title: list ? "Continue" : "Skip for now" },
      ],
      { title: "Connect", preselected: list ? "continue" : undefined },
    );
    if (!pick) return null;
    if (pick === "continue") return `Accounts: ${list || "none connected"}.`;

    try {
      const connected = pick === "whatsapp-web"
        ? await linkWhatsAppWeb(ctx, org)
        : await connectWithLink(
          ctx,
          org,
          pick as Exclude<Connectable, "whatsapp-web">,
        );
      notice = connected ? `Connected ${connected}.` : "";
    } catch (err) {
      notice = `Not connected: ${message(err)}.`;
    }
  }
}

// ── Contacts ────────────────────────────────────────────────────────────

type Candidate = { address: string; title: string };

function nameOf(extra: Record<string, unknown> | null): string | undefined {
  const e = (extra ?? {}) as {
    synced?: { name?: string };
    name?: string;
    username?: string;
  };
  return e.synced?.name ?? e.name ?? (e.username && `@${e.username}`);
}

/** The latest conversations, not allowed yet, named. */
async function recentConversations(
  ctx: SetupContext,
  org: Org,
  allowed: string[],
): Promise<Candidate[]> {
  const { data: conversations } = await ctx.supabase
    .from("conversations")
    .select("service, organization_address, address, name, type")
    .eq("organization_id", org.orgId)
    .neq("service", "local")
    .order("updated_at", { ascending: false })
    .limit(20)
    .throwOnError();

  const fresh = (conversations ?? [])
    .filter((c) => !allowed.some((a) => sameAddress(a, c.address)))
    .slice(0, 6);

  const { data: contacts } = await ctx.supabase
    .from("contacts_addresses")
    .select("service, organization_address, address, extra")
    .eq("organization_id", org.orgId)
    .in("address", fresh.map((c) => c.address));

  return fresh.map((c) => {
    const contact = (contacts ?? []).find((k) =>
      k.service === c.service &&
      k.organization_address === c.organization_address &&
      k.address === c.address
    );
    const name = c.type && c.type !== "direct"
      ? `${c.name ?? c.address} (${c.type})`
      : nameOf(contact?.extra);
    return {
      address: c.address,
      title: `${name ? `${name} · ` : ""}${c.address} · ${c.service}`,
    };
  });
}

async function searchContacts(
  ctx: SetupContext,
  org: Org,
  query: string,
): Promise<Candidate[]> {
  // PostgREST's or() syntax: no separators or wildcards from the user.
  const q = query.replace(/[,()*%\\]/g, " ").trim();
  const { data } = await ctx.supabase
    .from("contacts_addresses")
    .select("service, address, extra")
    .eq("organization_id", org.orgId)
    .neq("service", "local")
    .or(
      `extra->synced->>name.ilike.*${q}*,extra->>name.ilike.*${q}*,extra->>username.ilike.*${q}*,address.ilike.*${q}*`,
    )
    .limit(10)
    .throwOnError();

  return (data ?? []).map((c) => ({
    address: c.address,
    title: `${nameOf(c.extra) ?? c.address} · ${c.address} · ${c.service}`,
  }));
}

async function contactsStep(ctx: SetupContext): Promise<string | null> {
  const org = ctx.org();
  if (!org) return "Contacts: skipped, no organization.";

  let notice = "";
  while (true) {
    const allowed = loadConfig().allowedContacts;
    const recent = await recentConversations(ctx, org, allowed);

    const pick = await choose(
      ctx.ui,
      [
        notice,
        `Group chats reach the inbox, and anyone the live channel, only when allowlisted. ${
          allowed.length
            ? `Allowed: ${allowed.join(", ")}.`
            : "The allowlist is empty."
        }`,
      ].filter(Boolean).join("\n"),
      [
        ...recent.map((c) => ({
          value: `address:${c.address}`,
          title: c.title,
        })),
        { value: "search", title: "Search my contacts by name" },
        { value: "type", title: "Type a phone number or address" },
        {
          value: "continue",
          title: allowed.length ? "Continue" : "Skip for now",
        },
      ],
      { title: "Allow", preselected: allowed.length ? "continue" : undefined },
    );
    if (!pick) return null;
    if (pick === "continue") {
      return `Contacts: ${
        allowed.length ? allowed.join(", ") : "none allowed"
      }.`;
    }

    let address: string | null = null;
    if (pick.startsWith("address:")) {
      address = pick.slice("address:".length);
    } else if (pick === "type") {
      address = await ask(ctx.ui, "Who should Claude read?", {
        title: "Phone number or address",
        description:
          "A phone with its country code, an Instagram or TikTok id, a WhatsApp group (…@g.us), a Slack user or channel id",
      });
    } else {
      const query = await ask(ctx.ui, "Search your contacts", {
        title: "Name",
      });
      if (query) {
        const found = await searchContacts(ctx, org, query);
        const chosen = found.length
          ? await choose(
            ctx.ui,
            `Contacts matching "${query}"`,
            [
              ...found.map((c) => ({
                value: `address:${c.address}`,
                title: c.title,
              })),
              { value: "back", title: "None of these" },
            ],
          )
          : null;
        if (chosen?.startsWith("address:")) {
          address = chosen.slice("address:".length);
        }
        if (!found.length) notice = `No contact matches "${query}".`;
      }
    }

    if (address) {
      const entry = normalizeAddress(address);
      if (!allowed.some((a) => sameAddress(a, entry))) {
        updateConfig({ allowedContacts: [...allowed, entry] });
      }
      notice = `Allowed ${entry}.`;
    }
  }
}

// ── Answering ───────────────────────────────────────────────────────────

export const ANSWER_MODES: Record<AnswerMode, string> = {
  draft: "Draft each answer and ask me before sending it",
  reply: "Answer on my behalf",
  notify: "Only tell me what arrived",
};

async function answeringStep(ctx: SetupContext): Promise<string | null> {
  const { answering } = loadConfig();
  const answer = await form(
    ctx.ui,
    "How should Claude handle a new message?",
    {
      mode: {
        type: "string",
        title: "When a message arrives",
        oneOf: Object.entries(ANSWER_MODES).map(([value, title]) => ({
          const: value,
          title,
        })),
        default: answering.mode,
      },
      instructions: {
        type: "string",
        title: "How to answer (optional)",
        description:
          'Who you are, tone, language, what never to promise. E.g. "I\'m Ana, a dentist; answer in Spanish, short and warm; never confirm appointments."',
        default: answering.instructions ?? "",
      },
    },
    ["mode"],
  );
  if (!answer) return null;

  const mode = answer.mode as AnswerMode;
  const instructions = (answer.instructions as string | undefined)?.trim();
  updateConfig({
    answering: { mode, ...(instructions ? { instructions } : {}) },
  });
  return `Answering: ${ANSWER_MODES[mode].toLowerCase()}.${
    instructions ? ` Instructions: ${instructions}` : ""
  }`;
}

// ── Checking ────────────────────────────────────────────────────────────

async function checkingStep(ctx: SetupContext): Promise<string | null> {
  const every = await choose(
    ctx.ui,
    "How often should Claude check for new messages? It checks while this Claude Code session is open.",
    [
      { value: "5m", title: "Every 5 minutes" },
      { value: "15m", title: "Every 15 minutes" },
      { value: "1h", title: "Every hour" },
      { value: "ask", title: "Only when I ask" },
    ],
    { title: "Check", preselected: loadConfig().checkEvery ?? "15m" },
  );
  if (!every) return null;

  if (every === "ask") {
    updateConfig({ checkEvery: undefined });
    return "Checking: when the user asks (/openbsp:inbox).";
  }

  updateConfig({ checkEvery: every });
  return `Checking: every ${every}, as the user chose. Start it now: run the loop skill with \`${every} /openbsp:inbox\` (the user's /loop ${every} /openbsp:inbox).`;
}

// ── Run ─────────────────────────────────────────────────────────────────

const RUNNERS: Record<Step, Runner> = {
  organization: organizationStep,
  accounts: accountsStep,
  contacts: contactsStep,
  answering: answeringStep,
  checking: checkingStep,
};

export async function runSetup(
  ctx: SetupContext,
  only?: Step,
): Promise<string> {
  const user = await ctx.signIn();
  const lines = [`Signed in as ${user}.`];

  for (const step of only ? [only] : FIRST_RUN) {
    const line = await RUNNERS[step](ctx, !!only);
    if (line === null) {
      lines.push(
        `Stopped at the ${step} step (dismissed). /openbsp:setup ${step} picks it up again.`,
      );
      break;
    }
    lines.push(line);
  }

  return lines.join("\n");
}

/**
 * First run, in TUI menus: sign in, create or join an organization, connect
 * accounts, choose how often Claude checks. Each step also runs on its own,
 * contacts (the allowlist) among them. How, when and what to answer is the
 * user's to tell Claude, not a setting.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { callFunction } from "./api.ts";
import { loadConfig, updateConfig } from "./config.ts";
import {
  ask,
  Back,
  type Choice,
  choose,
  pick,
  poll,
  Stopped,
  type Ui,
  waitFor,
} from "./menus.ts";
import { normalizeAddress, sameAddress } from "./messages.ts";
import { PERMISSIONS } from "./permission.ts";
import type { Permission } from "./config.ts";
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
  "permissions",
  "checking",
] as const;

export type Step = typeof STEPS[number];

// The allowlist is for the channel and group chats: the inbox reads every
// one-to-one conversation without it, so a first setup skips it.
const FIRST_RUN: Step[] = [
  "organization",
  "accounts",
  "permissions",
  "checking",
];

export type SetupContext = {
  ui: Ui;
  supabase: SupabaseClient;
  /** Signs in when needed; the signed-in user. */
  signIn: () => Promise<string>;
  org: () => Org | null;
  /** Work in this organization from now on. */
  useOrg: (orgId: string) => Promise<void>;
};

// A step's line for the summary. Its menus throw Back (Decline) and Stopped
// (Esc). `explicit`: the user asked for it, or came back to it.
type Runner = (ctx: SetupContext, explicit: boolean) => Promise<string>;

// The last line of a menu. The TUI shows a dialog's first three lines, each
// cut to the terminal's width.
const KEYS = "Accept goes on, Decline goes back.";

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// ── Organization ────────────────────────────────────────────────────────

async function organizationStep(
  ctx: SetupContext,
  explicit: boolean,
): Promise<string> {
  const [orgs, invitations] = await Promise.all([
    listOrgs(ctx.supabase),
    listInvitations(ctx.supabase),
  ]);
  const current = ctx.org();

  // Nothing to decide: the only organization, no invitation.
  if (!explicit && current && orgs.length === 1 && invitations.length === 0) {
    return `Organization: ${current.orgName}.`;
  }

  const choices: Choice[] = [
    ...orgs.map((o) => ({
      value: `org:${o.orgId}`,
      title: o.orgId === current?.orgId ? `${o.orgName} (current)` : o.orgName,
    })),
    ...invitations.map((i) => ({
      value: `invitation:${i.id}`,
      title: `Join ${i.organization_name ?? "an organization"}${
        i.invited_by_name ? `, invited by ${i.invited_by_name}` : ""
      }`,
    })),
    { value: "new", title: "Create a new organization" },
  ];

  while (true) {
    // With none to pick from, straight to creating one: Decline there
    // leaves the step.
    const picked = choices.length === 1 ? "new" : await choose(
      ctx.ui,
      [
        orgs.length > 0
          ? "Which organization should Claude work in? Tick one."
          : "You've been invited to an organization. Join it, or create your own.",
        KEYS,
      ].join("\n"),
      choices,
      current ? `org:${current.orgId}` : undefined,
    );

    if (!picked) {
      if (current) return `Organization: ${current.orgName}.`;
      continue; // there's none to keep: one must be ticked
    }

    if (picked.startsWith("org:")) {
      const org = orgs.find((o) => `org:${o.orgId}` === picked)!;
      if (org.orgId !== current?.orgId) await ctx.useOrg(org.orgId);
      return `Organization: ${org.orgName}.`;
    }

    if (picked.startsWith("invitation:")) {
      const invitation = invitations.find((i) =>
        `invitation:${i.id}` === picked
      )!;
      await ctx.useOrg(await acceptInvitation(ctx.supabase, invitation));
      return `Organization: joined ${invitation.organization_name ?? "it"}.`;
    }

    const {
      data: { user },
    } = await ctx.supabase.auth.getUser();
    let name: string | null;
    try {
      name = await ask(
        ctx.ui,
        "Create your organization. It holds your connected accounts, your conversations and your team.",
        {
          title: "Organization name",
          default: user?.user_metadata?.full_name ?? "",
        },
      );
    } catch (err) {
      if (err instanceof Back && choices.length > 1) continue;
      throw err;
    }
    if (!name) continue;

    await ctx.useOrg(await createOrg(ctx.supabase, name));
    return `Organization: created ${name}.`;
  }
}

// ── Accounts ────────────────────────────────────────────────────────────

type Connectable = "whatsapp" | "whatsapp-web" | "instagram" | "tiktok";

const SERVICES: { value: Connectable; title: string }[] = [
  { value: "whatsapp", title: "WhatsApp — business account, official API" },
  {
    value: "whatsapp-web",
    title: "WhatsApp Web — any account, unofficial API",
  },
  { value: "instagram", title: "Instagram — professional account" },
  { value: "tiktok", title: "TikTok — business account" },
];

const SERVICE_NAMES: Record<Connectable, string> = {
  whatsapp: "WhatsApp Business",
  "whatsapp-web": "WhatsApp Web",
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
): Promise<string> {
  const phone = await ask(
    ctx.ui,
    // Three lines, under 100 characters each: the TUI cuts the rest.
    [
      "Unofficial API: WhatsApp may ban this number, above all for messaging people who haven't saved it.",
      "Campaigns and cold outreach belong on a business account, through the official API.",
      "Type the number to link; you'll then type a code on your phone.",
    ].join("\n"),
    {
      title: "Phone number",
      description: "With the country code, e.g. +54 9 11 5555 1234",
    },
  );
  if (!phone) throw new Back();

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
    message: [
      `Type the code ${pairing.pairing_code} on your phone.`,
      "WhatsApp › Settings › Linked devices › Link a device › Link with phone number instead.",
      "This closes by itself once it's linked.",
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

async function accountsStep(ctx: SetupContext): Promise<string> {
  const org = ctx.org();
  if (!org) return "Accounts: skipped, no organization.";

  // Onboarding links are admin+; a member links their own WhatsApp only.
  const services = org.role === "member"
    ? SERVICES.filter((s) => s.value === "whatsapp-web")
    : SERVICES;

  let notices: string[] = [];
  while (true) {
    const accounts = await resolveAccounts(ctx.supabase, org.orgId);
    const list = [...accounts.values()]
      .map((a) => `${a.service} ${a.label}`)
      .join(", ");

    const picked = await pick(
      ctx.ui,
      [
        notices.join(" "),
        list
          ? `Connected: ${list}. Tick more to connect, or none to go on.`
          : "Tick the accounts whose messages Claude reads and answers.",
        KEYS,
      ].filter(Boolean).join("\n"),
      services,
    );
    if (!picked.length) return `Accounts: ${list || "none connected"}.`;

    notices = [];
    for (const service of picked as Connectable[]) {
      try {
        const connected = service === "whatsapp-web"
          ? await linkWhatsAppWeb(ctx, org)
          : await connectWithLink(ctx, org, service);
        notices.push(`Connected ${connected}.`);
      } catch (err) {
        if (err instanceof Stopped) throw err;
        notices.push(
          err instanceof Back
            ? `${SERVICE_NAMES[service]}: not connected.`
            : `${SERVICE_NAMES[service]} not connected: ${message(err)}.`,
        );
      }
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

async function contactsStep(ctx: SetupContext): Promise<string> {
  const org = ctx.org();
  if (!org) return "Contacts: skipped, no organization.";

  let notice = "";
  while (true) {
    const allowed = loadConfig().allowedContacts;
    const recent = await recentConversations(ctx, org, allowed);

    // The allowlist comes ticked: unticking an entry removes it.
    const choices: Choice[] = [
      ...allowed.map((a) => ({ value: `address:${a}`, title: a })),
      ...recent.map((c) => ({ value: `address:${c.address}`, title: c.title })),
      { value: "search", title: "Search my contacts by name" },
      { value: "type", title: "Type a phone number or address" },
    ];
    const picked = await pick(
      ctx.ui,
      [
        `${notice}Group chats reach the inbox, and anyone the live channel, only when ticked here.`,
        KEYS,
      ].join("\n"),
      choices,
      allowed.map((a) => `address:${a}`),
    );

    const addresses = picked
      .filter((v) => v.startsWith("address:"))
      .map((v) => normalizeAddress(v.slice("address:".length)));
    notice = "";
    try {
      if (picked.includes("type")) {
        const typed = await ask(ctx.ui, "Who should Claude read?", {
          title: "Phone number or address",
          description:
            "A phone with its country code, an Instagram or TikTok id, a WhatsApp group (…@g.us), a Slack user or channel id",
        });
        if (typed) addresses.push(normalizeAddress(typed));
      }
      if (picked.includes("search")) {
        const query = await ask(ctx.ui, "Search your contacts", {
          title: "Name",
        });
        const found = query ? await searchContacts(ctx, org, query) : [];
        if (found.length) {
          const chosen = await pick(
            ctx.ui,
            [`Contacts matching "${query}". Tick the ones to allow.`, KEYS]
              .join("\n"),
            found.map((c) => ({ value: c.address, title: c.title })),
          );
          addresses.push(...chosen.map(normalizeAddress));
        } else if (query) {
          notice = `No contact matches "${query}". `;
        }
      }
    } catch (err) {
      if (!(err instanceof Back)) throw err;
    }

    const next = addresses.filter((a, i) =>
      addresses.findIndex((b) => sameAddress(a, b)) === i
    );
    updateConfig({ allowedContacts: next });

    // Ticking and unticking alone ends the step; a search or a typed
    // address comes back to the list.
    if (!picked.includes("type") && !picked.includes("search")) {
      return `Contacts: ${next.length ? next.join(", ") : "none allowed"}.`;
    }
  }
}

// ── Permissions ─────────────────────────────────────────────────────────

async function permissionsStep(ctx: SetupContext): Promise<string> {
  const current = loadConfig().permission;
  const mode = (await choose(
    ctx.ui,
    [
      "May Claude send messages and change things, like contacts or templates? Tick one.",
      KEYS,
    ].join("\n"),
    Object.entries(PERMISSIONS).map(([value, title]) => ({ value, title })),
    current,
  ) ?? current) as Permission;

  updateConfig({ permission: mode });
  return `Permissions: ${PERMISSIONS[mode].toLowerCase()}.`;
}

// ── Checking ────────────────────────────────────────────────────────────

const EVERY: Choice[] = [
  { value: "5m", title: "Every 5 minutes" },
  { value: "15m", title: "Every 15 minutes" },
  { value: "1h", title: "Every hour" },
  { value: "ask", title: "Only when I ask" },
];

async function checkingStep(ctx: SetupContext): Promise<string> {
  const current = loadConfig().checkEvery ?? "15m";
  const every = await choose(
    ctx.ui,
    [
      "How often should Claude check for new messages, while this session is open? Tick one.",
      KEYS,
    ].join("\n"),
    EVERY,
    current,
  ) ?? current;

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
  permissions: permissionsStep,
  checking: checkingStep,
};

const ANSWERING =
  "Next: the user tells Claude how, when and what to answer — who they are, the tone, what never to promise. Tell them so, and offer to keep it in CLAUDE.md for later sessions.";

export async function runSetup(
  ctx: SetupContext,
  only?: Step,
): Promise<string> {
  let user: string;
  try {
    user = await ctx.signIn();
  } catch (err) {
    if (err instanceof Back || err instanceof Stopped) {
      return "The user cancelled the sign-in. /openbsp:setup starts again.";
    }
    throw err;
  }
  const steps = only ? [only] : FIRST_RUN;
  const lines = new Map<Step, string>();

  let i = 0;
  let back = false;
  while (i < steps.length) {
    const step = steps[i];
    try {
      lines.set(step, await RUNNERS[step](ctx, !!only || back));
      back = false;
      i++;
    } catch (err) {
      if (!(err instanceof Back || err instanceof Stopped)) throw err;
      // Back from the first step leaves, like Esc.
      if (err instanceof Back && i > 0) {
        back = true;
        i--;
        continue;
      }
      return [
        `Signed in as ${user}.`,
        ...lines.values(),
        `Stopped at the ${step} step. /openbsp:setup ${step} picks it up again.`,
      ].join("\n");
    }
  }

  return [
    `Signed in as ${user}.`,
    ...lines.values(),
    ...(only ? [] : [ANSWERING]),
  ].join("\n");
}

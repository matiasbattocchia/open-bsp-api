/**
 * First run, question by question: sign in, create or join an organization,
 * connect accounts, choose how often Claude checks. Each step also runs on
 * its own. What Claude may do is the permission mode, set in /config; how,
 * when and what to answer is the user's to tell Claude, not a setting.
 *
 * The hooks module (hooks/register.ts) asks each question in Claude Code's
 * picker, where Enter on an option picks it and goes on, and answers with
 * the label picked or the text typed; where hooks don't run, Claude asks
 * them. The dialogs that close by themselves once something lands (a
 * sign-in, a connection, a pairing code) are the plugin's own.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { callFunction } from "./api.ts";
import { loadConfig, updateConfig } from "./config.ts";
import { ask, Back, poll, Stopped, type Ui, waitFor } from "./dialogs.ts";
import {
  acceptInvitation,
  accountLabel,
  createOrg,
  listInvitations,
  listOrgs,
  type Org,
  resolveAccounts,
} from "./org.ts";
import { type Provider, PROVIDERS } from "./auth.ts";

export const STEPS = ["organization", "accounts", "checking"] as const;

export type Step = typeof STEPS[number];

export type SetupContext = {
  ui: Ui;
  supabase: SupabaseClient;
  /** The signed-in user, if any. */
  user: () => string | null;
  /** Signs in in the browser; the signed-in user. */
  signIn: (provider: Provider) => Promise<string>;
  org: () => Org | null;
  /** Work in this organization from now on. */
  useOrg: (orgId: string) => Promise<void>;
};

/**
 * A question for the picker: up to four options, each with what picking it
 * does. `typed` takes the picker's own "Type something".
 */
export type Question = {
  header: string; // 12 characters at most
  question: string;
  options: { label: string; then: () => Promise<Outcome> }[];
  typed?: { hint: string; then: (text: string) => Promise<Outcome> };
};

/** A step's next question, or its line for the summary once it's done. */
type Outcome = Question | string;

type Runner = (ctx: SetupContext, explicit: boolean) => Promise<Outcome>;

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const same = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

// For finding a name by part of it: no case, no accents (Médico, medico).
const plain = (text: string) =>
  text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

// Actions are marked, so they read apart from the names among them.
const BACK = "← Back";
const UP = "↑ Up";
const DOWN = "↓ Down";
const add = (label: string) => `+ ${label}`;

// ── Sign-in ─────────────────────────────────────────────────────────────

function signInQuestion(
  ctx: SetupContext,
  first: () => Promise<Outcome>,
): Question {
  return {
    header: "Sign in",
    question: "Sign in to OpenBSP with? A first sign-in creates your account.",
    options: Object.entries(PROVIDERS).map(([provider, label]) => ({
      label,
      then: async () => {
        await ctx.signIn(provider as Provider);
        return await first();
      },
    })),
  };
}

// ── Organization ────────────────────────────────────────────────────────

async function organizationStep(
  ctx: SetupContext,
  explicit: boolean,
): Promise<Outcome> {
  const [orgs, invitations] = await Promise.all([
    listOrgs(ctx.supabase),
    listInvitations(ctx.supabase),
  ]);
  const current = ctx.org();

  // Nothing to decide: the only organization, no invitation.
  if (!explicit && current && orgs.length === 1 && invitations.length === 0) {
    return `Organization: ${current.orgName}.`;
  }
  if (orgs.length === 0 && invitations.length === 0) {
    return await nameQuestion(ctx);
  }

  const use = (org: Org) => async () => {
    if (org.orgId !== current?.orgId) await ctx.useOrg(org.orgId);
    return `Organization: ${org.orgName}.`;
  };
  const join = (invitation: typeof invitations[number]) => async () => {
    await ctx.useOrg(await acceptInvitation(ctx.supabase, invitation));
    return `Organization: joined ${invitation.organization_name ?? "it"}.`;
  };

  // The current one first: Enter keeps it.
  const entries = [
    ...orgs.filter((o) => o.orgId === current?.orgId).map((o) => ({
      label: `${o.orgName} (current)`,
      then: use(o),
    })),
    ...invitations.map((i) => ({
      label: `✉ Join ${i.organization_name ?? "an organization"}${
        i.invited_by_name ? `, invited by ${i.invited_by_name}` : ""
      }`,
      then: join(i),
    })),
    ...orgs.filter((o) => o.orgId !== current?.orgId).map((o) => ({
      label: o.orgName,
      then: use(o),
    })),
  ];

  // A typed name, or part of one: one match is picked, several asked about.
  const find = async (text: string): Promise<Outcome> => {
    const named = (name: string | null) =>
      !!name && plain(name).includes(plain(text));
    const matches = [
      ...orgs.filter((o) => named(o.orgName)).map((o) => ({
        label: o.orgName,
        then: use(o),
      })),
      ...invitations.filter((i) => named(i.organization_name)).map((i) => ({
        label: `✉ Join ${i.organization_name}`,
        then: join(i),
      })),
    ];
    if (matches.length === 1) return await matches[0].then();
    if (matches.length === 0) {
      const first = page(0);
      return {
        ...first,
        question: `No organization matches "${text}". ${first.question}`,
      };
    }
    return {
      header: "Organization",
      question: `${matches.length} organizations match "${text}". Which one?${
        matches.length > 3 ? " Or type more of the name." : ""
      }`,
      options: [
        ...matches.slice(0, 3),
        { label: BACK, then: () => Promise.resolve(page(0)) },
      ],
      typed: { hint: "more of the name", then: find },
    };
  };

  // Up to three fit with Create. More page down: three on the first page,
  // two on each after it (Up takes a place), and Create at the very end.
  const page = (p: number): Question => {
    const from = p === 0 ? 0 : 3 + (p - 1) * 2;
    const shown = entries.length > 3
      ? entries.slice(from, from + (p === 0 ? 3 : 2))
      : entries;
    const more = from + shown.length < entries.length;
    return {
      header: "Organization",
      question: entries.length > 3
        ? `Which organization should Claude work in? ${
          shown.length === 1 ? from + 1 : `${from + 1}–${from + shown.length}`
        } of ${entries.length}; or type part of a name.`
        : "Which organization should Claude work in?",
      options: [
        ...(p > 0
          ? [{ label: UP, then: () => Promise.resolve(page(p - 1)) }]
          : []),
        ...shown,
        more ? { label: DOWN, then: () => Promise.resolve(page(p + 1)) } : {
          label: add("Create a new organization"),
          then: () => nameQuestion(ctx, page(p)),
        },
      ],
      typed: { hint: "an organization's name, or part of it", then: find },
    };
  };
  return page(0);
}

async function nameQuestion(
  ctx: SetupContext,
  back?: Question,
): Promise<Question> {
  const {
    data: { user },
  } = await ctx.supabase.auth.getUser();
  const create = (name: string) => async () => {
    await ctx.useOrg(await createOrg(ctx.supabase, name));
    return `Organization: created ${name}.`;
  };

  const names = [
    ...new Set(
      [user?.user_metadata?.full_name, user?.email?.split("@")[0]]
        .filter((n): n is string => !!n),
    ),
  ];
  const options: Question["options"] = names.map((name) => ({
    label: name,
    then: create(name),
  }));
  if (back) options.push({ label: BACK, then: () => Promise.resolve(back) });
  if (options.length < 2) {
    options.push({
      label: "My organization",
      then: create("My organization"),
    });
  }

  return {
    header: "Organization",
    question:
      "Name your new organization — it holds your accounts, conversations and team. Pick a name or type one.",
    options,
    typed: {
      hint: "the organization's name",
      then: (name) => create(name.trim())(),
    },
  };
}

// ── Accounts ────────────────────────────────────────────────────────────

type Connectable = "whatsapp" | "whatsapp-web" | "instagram" | "tiktok";

const SERVICES: Record<Connectable, string> = {
  whatsapp: "WhatsApp — business account, official API",
  "whatsapp-web": "WhatsApp Web — any account, unofficial API",
  instagram: "Instagram — professional account",
  tiktok: "TikTok — business account",
};

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

async function accountsStep(
  ctx: SetupContext,
  notice = "",
): Promise<Outcome> {
  const org = ctx.org();
  if (!org) return "Accounts: skipped, no organization.";

  const accounts = await resolveAccounts(ctx.supabase, org.orgId);
  const list = [...accounts.values()]
    .map((a) => `${a.service} ${a.label}`)
    .join(", ");

  const connect = (service: Connectable) => async (): Promise<Outcome> => {
    let note: string;
    try {
      note = `Connected ${
        service === "whatsapp-web"
          ? await linkWhatsAppWeb(ctx, org)
          : await connectWithLink(ctx, org, service)
      }.`;
    } catch (err) {
      note = err instanceof Back || err instanceof Stopped
        ? `${SERVICE_NAMES[service]}: not connected.`
        : `${SERVICE_NAMES[service]} not connected: ${message(err)}.`;
    }
    return await accountsStep(ctx, note);
  };
  const option = (service: Connectable) => ({
    label: add(SERVICES[service]),
    then: connect(service),
  });

  const done = {
    label: list ? "✓ Continue" : "✓ Skip for now",
    then: () => Promise.resolve(`Accounts: ${list || "none connected"}.`),
  };
  // Onboarding links are admin+; a member links their own WhatsApp only.
  const services = org.role === "member" ? [option("whatsapp-web")] : [
    option("whatsapp"),
    option("whatsapp-web"),
    {
      label: add("Instagram or TikTok — business account"),
      then: () =>
        Promise.resolve<Question>({
          header: "Accounts",
          question: "Which one?",
          options: [
            option("instagram"),
            option("tiktok"),
            { label: BACK, then: () => accountsStep(ctx, notice) },
          ],
        }),
    },
  ];

  return {
    header: "Accounts",
    question: [
      notice,
      list
        ? `Connected: ${list}. Connect another one?`
        : "Connect the accounts whose messages Claude reads and answers.",
    ].filter(Boolean).join(" "),
    // Once one is connected, Enter goes on.
    options: list ? [done, ...services] : [...services, done],
  };
}

// ── Checking ────────────────────────────────────────────────────────────

const EVERY: Record<string, string> = {
  "3m": "Every 3 minutes",
  "10m": "Every 10 minutes",
  ask: "Only when I ask",
};

function checkingStep(): Promise<Outcome> {
  const set = loadConfig().checkEvery;
  // An interval no longer offered (an earlier version's 15m) isn't current.
  const current = set && set in EVERY ? set : undefined;
  const first = current ?? "3m";
  return Promise.resolve({
    header: "Checking",
    question:
      `How often should Claude check for new messages, while this session is open?${
        set && !current ? ` Now every ${set}.` : ""
      }`,
    // The current one first (else every 3 minutes): Enter takes it.
    options: [first, ...Object.keys(EVERY).filter((e) => e !== first)].map(
      (every) => ({
        label: every === current ? `${EVERY[every]} (current)` : EVERY[every],
        then: () => {
          if (every === "ask") {
            updateConfig({ checkEvery: undefined });
            return Promise.resolve(
              "Checking: when the user asks (/openbsp:inbox).",
            );
          }
          updateConfig({ checkEvery: every });
          return Promise.resolve(
            `Checking: every ${every}, as the user chose. Start it now: run the loop skill with \`${every} /openbsp:inbox\` (the user's /loop ${every} /openbsp:inbox).`,
          );
        },
      }),
    ),
  });
}

// ── Run ─────────────────────────────────────────────────────────────────

const RUNNERS: Record<Step, Runner> = {
  organization: organizationStep,
  accounts: (ctx) => accountsStep(ctx),
  checking: checkingStep,
};

const ANSWERING = [
  "Permission mode: whether Claude may send and change things (read only, ask first, allow) is in /config: search OpenBSP. Tell the user so.",
  "Next: the user tells Claude how, when and what to answer — who they are, the tone, what never to promise. Tell them so, and offer to keep it in CLAUDE.md for later sessions.",
].join("\n");

/** What the setup tool returns: the next question, or the summary. */
export type Turn = { ask: Question } | { summary: string };

/**
 * One setup, across the setup tool's calls: each call answers the question
 * the last one asked.
 */
export class Setup {
  private readonly steps: Step[];
  private readonly lines = new Map<Step, string>();
  private i = 0;
  private pending?: Question;

  constructor(
    private readonly ctx: SetupContext,
    private readonly only?: Step,
  ) {
    this.steps = only ? [only] : [...STEPS];
  }

  /** The step a question is waiting in. */
  get step(): Step {
    return this.steps[Math.min(this.i, this.steps.length - 1)];
  }

  async start(): Promise<Turn> {
    const first = () => RUNNERS[this.steps[0]](this.ctx, !!this.only);
    return await this.advance(
      this.ctx.user() ? await first() : signInQuestion(this.ctx, first),
    );
  }

  async answer(answer: string): Promise<Turn> {
    const q = this.pending!;
    const option = q.options.find((o) => o.label === answer) ??
      q.options.find((o) => same(o.label, answer));

    let outcome: Outcome;
    try {
      if (option) outcome = await option.then();
      else if (q.typed) outcome = await q.typed.then(answer.trim());
      else outcome = { ...q, question: `Pick one of these. ${q.question}` };
    } catch (err) {
      if (!(err instanceof Back || err instanceof Stopped)) throw err;
      // A dialog of the plugin's own, left: the sign-in, say.
      return {
        summary: this.summary(
          `The user stopped the setup at the ${this.step} step. Don't ask its questions yourself: when they want to go on, call setup again with step "${this.step}".`,
        ),
      };
    }
    return await this.advance(outcome);
  }

  private async advance(outcome: Outcome): Promise<Turn> {
    while (typeof outcome === "string") {
      this.lines.set(this.steps[this.i], outcome);
      this.i++;
      if (this.i >= this.steps.length) {
        return { summary: this.summary(this.only ? undefined : ANSWERING) };
      }
      outcome = await RUNNERS[this.steps[this.i]](this.ctx, !!this.only);
    }
    this.pending = outcome;
    return { ask: outcome };
  }

  private summary(last?: string): string {
    const user = this.ctx.user();
    return [
      user ? `Signed in as ${user}.` : "Not signed in.",
      ...this.lines.values(),
      ...(last ? [last] : []),
    ].join("\n");
  }
}

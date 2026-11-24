// Getting set up through the remote server: what is set up, the person's
// organizations, and connecting accounts. The plugin's setup asks its
// questions in Claude Code's picker and waits in dialogs that close by
// themselves; a stateless server can do neither, so here Claude asks in chat
// and calls these one at a time. An account connects in the browser (a link)
// or on the phone (a pairing code), and `status` shows it once it has.
import { accountLabel } from "../_shared/inbox.ts";
import {
  acceptInvitation,
  createOrg,
  listInvitations,
} from "../_shared/organizations.ts";
import { APP_URL } from "../_shared/urls.ts";
import type { OrganizationAddressIssue } from "../_shared/types/extra_types.ts";
import { callFunction } from "./api.ts";
import {
  type Caller,
  current,
  type Membership,
  memberships,
  NO_ORG,
  type Person,
  remember,
  workspace,
} from "./caller.ts";

// For finding a name by part of it: no case, no accents (Médico, medico).
const plain = (text: string) =>
  text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

// Organizations named in status before it points to `organizations`.
const NAMED = 5;

export const SERVICES = {
  whatsapp: "WhatsApp Business (official API)",
  instagram: "Instagram",
  tiktok: "TikTok",
  "whatsapp-web": "WhatsApp Web",
} as const;

export type Connectable = keyof typeof SERVICES;

/** The organization's accounts, every state, a line each. */
async function accountLines(caller: Caller, orgId: string): Promise<string[]> {
  const { data } = await caller.supabase
    .from("organizations_addresses")
    .select("service, address, status, issue, extra")
    .eq("organization_id", orgId)
    .neq("service", "local")
    .order("service")
    .throwOnError();

  return data.map((a) => {
    const i = a.issue as OrganizationAddressIssue | null;
    const issue = i
      ? ` (${i.reason}${i.detail ? `: ${i.detail}` : ""}${
        i.until ? `, until ${i.until}` : ""
      })`
      : "";
    return `- ${a.service} ${
      accountLabel(a.address, a.extra)
    }: ${a.status}${issue}`;
  });
}

export async function status(caller: Caller): Promise<string> {
  if (caller.kind === "key") {
    const { data: org } = await caller.supabase
      .from("organizations")
      .select("name")
      .eq("id", caller.orgId)
      .maybeSingle();
    const accounts = await accountLines(caller, caller.orgId);
    return [
      `API key "${caller.name}" (${caller.role}) of ${
        org?.name ?? caller.orgId
      }.`,
      ...(caller.allowedAccounts.length
        ? [`Limited to the accounts ${caller.allowedAccounts.join(", ")}.`]
        : []),
      ...(caller.allowedContacts.length
        ? [`Limited to the contacts ${caller.allowedContacts.join(", ")}.`]
        : []),
      accounts.length ? "Accounts:" : "No accounts connected.",
      ...accounts,
    ].join("\n");
  }

  const [list, invitations] = await Promise.all([
    memberships(caller),
    listInvitations(caller.supabase, caller.email),
  ]);
  const org = current(list);
  const signedIn = `Signed in as ${caller.email ?? caller.userId}.`;
  const invited = invitations.length
    ? `Invitations waiting: ${
      invitations.map((i) => i.organization_name ?? i.organization_id).join(
        ", ",
      )
    } (set_organization joins one).`
    : undefined;

  if (!org) {
    return [signedIn, NO_ORG, invited].filter(Boolean).join("\n");
  }

  const others = list.filter((m) => m !== org);
  const accounts = await accountLines(caller, org.orgId);
  return [
    signedIn,
    `Organization: ${org.orgName} (${org.role}).${
      others.length
        ? ` Also a member of ${
          others.length > NAMED
            ? `${others.length} others (organizations lists them)`
            : others.map((m) => m.orgName).join(", ")
        }; set_organization switches.`
        : ""
    }`,
    ...(invited ? [invited] : []),
    accounts.length
      ? "Accounts:"
      : "No accounts connected: connect connects one.",
    ...accounts,
  ].join("\n");
}

export async function organizations(
  person: Person,
  name?: string,
): Promise<string> {
  const [list, invitations] = await Promise.all([
    memberships(person),
    listInvitations(person.supabase, person.email),
  ]);
  const org = current(list);
  const named = (text: string | null) =>
    !name || (!!text && plain(text).includes(plain(name)));

  const orgs = list.filter((m) => named(m.orgName));
  const invited = invitations.filter((i) => named(i.organization_name));
  if (!orgs.length && !invited.length) {
    return name
      ? `No organization matches "${name}" (${list.length} in all).`
      : "No organizations, and no invitations waiting: set_organization creates one.";
  }

  return [
    ...orgs.map((m) =>
      `- ${m.orgName} (${m.role})${m === org ? ", current" : ""}: ${m.orgId}`
    ),
    ...(invited.length ? ["Invitations:"] : []),
    ...invited.map((i) =>
      `- ${i.organization_name ?? "an organization"}${
        i.invited_by_name ? `, invited by ${i.invited_by_name}` : ""
      }, as ${i.role}: ${i.id}`
    ),
  ].join("\n");
}

/** Work in one of the person's organizations, a new one, or one they join. */
export async function setOrganization(
  person: Person,
  args: { organization?: string; create?: string; join?: string },
): Promise<string> {
  const given = [args.organization, args.create, args.join].filter(Boolean);
  if (given.length !== 1) {
    throw new Error("give exactly one of organization, create or join");
  }

  let orgId: string;
  let done: string;
  if (args.create) {
    orgId = await createOrg(person.supabase, args.create.trim());
    done = `Created ${args.create.trim()}, and working in it now.`;
  } else if (args.join) {
    const invitations = await listInvitations(person.supabase, person.email);
    const matches = invitations.filter((i) =>
      i.id === args.join ||
      (!!i.organization_name &&
        plain(i.organization_name).includes(plain(args.join!)))
    );
    if (matches.length !== 1) {
      throw new Error(
        matches.length
          ? `${matches.length} invitations match "${args.join}": give its id (organizations lists them)`
          : `no invitation matches "${args.join}"`,
      );
    }
    orgId = await acceptInvitation(person.supabase, matches[0]);
    done = `Joined ${
      matches[0].organization_name ?? "it"
    }, and working in it now.`;
  } else {
    const list = await memberships(person);
    const wanted = args.organization!;
    const exact = list.find((m) =>
      m.orgId === wanted || plain(m.orgName) === plain(wanted)
    );
    const matches = exact
      ? [exact]
      : list.filter((m) => plain(m.orgName).includes(plain(wanted)));
    if (matches.length !== 1) {
      throw new Error(
        matches.length
          ? `${matches.length} organizations match "${wanted}": ${
            matches.slice(0, 10).map((m) => m.orgName).join(", ")
          }. Give more of the name, or its id.`
          : `no organization of yours matches "${wanted}" (organizations lists them)`,
      );
    }
    orgId = matches[0].orgId;
    done = `Working in ${matches[0].orgName} now.`;
  }

  const membership = (await memberships(person)).find((m) => m.orgId === orgId);
  if (!membership) throw new Error("the membership isn't readable yet");
  await remember(person, membership, { picked_at: new Date().toISOString() });

  const accounts = await accountLines(person, orgId);
  return [
    done,
    accounts.length
      ? "Accounts:"
      : "No accounts connected yet: connect connects one.",
    ...accounts,
  ].join("\n");
}

type Pairing = {
  session_id: string;
  status: "pending" | "paired" | "error";
  pairing_code?: string;
  error?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Start connecting an account: a link for the user to open, or a code to type
 * on their phone. It connects once they're done; `status` shows it.
 */
export async function connect(
  caller: Caller,
  args: { service: Connectable; phone_number?: string },
): Promise<string> {
  const { orgId, role, membership } = await workspace(caller);
  const service = args.service;
  if (!(service in SERVICES)) {
    throw new Error(`service must be one of: ${Object.keys(SERVICES)}`);
  }

  if (service === "whatsapp-web") {
    if (caller.kind === "key") {
      throw new Error(
        "an API key can't link WhatsApp Web: a person links it, signed in (the OpenBSP app, or Claude with their own sign-in)",
      );
    }
    return await pairWhatsAppWeb(caller, orgId, membership!, args.phone_number);
  }

  // Onboarding links are admin+; a member links their own WhatsApp only.
  if (role === "member") {
    throw new Error(
      "connecting the organization's accounts takes an admin; a member links their own WhatsApp (whatsapp-web)",
    );
  }

  const { data: token } = await caller.supabase
    .from("onboarding_tokens")
    .insert({
      name: "MCP",
      organization_id: orgId,
      service,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    .select("id")
    .single()
    .throwOnError();

  return [
    `Give the user this link to connect their ${
      SERVICES[service]
    } account, with that service's own sign-in: ${APP_URL}/onboard/${service}/${token.id}`,
    "It works for an hour, and needs no OpenBSP sign-in, so anyone they share it with can connect an account here. Once they say it's done, call status to see it connected.",
  ].join("\n");
}

async function pairWhatsAppWeb(
  person: Person,
  orgId: string,
  membership: Membership,
  phone?: string,
): Promise<string> {
  const digits = phone?.replace(/\D/g, "");
  if (!digits) {
    throw new Error(
      "phone_number is required: the number to link, with its country code",
    );
  }

  let pairing = await callFunction<Pairing>(
    person,
    "POST",
    "whatsapp-web-management/sessions",
    {
      organization_id: orgId,
      phone_number: digits,
      // A member links their own number; an admin, the organization's.
      ...(membership.role === "member" ? { agent_id: membership.agentId } : {}),
    },
  );

  // The bridge takes a moment to have the code.
  for (let i = 0; !pairing.pairing_code && i < 30; i++) {
    if (pairing.status === "error") {
      throw new Error(pairing.error ?? "pairing failed");
    }
    await sleep(1000);
    pairing = await callFunction<Pairing>(
      person,
      "GET",
      `whatsapp-web-management/sessions/pending/${pairing.session_id}?organization_id=${orgId}`,
    );
  }
  if (!pairing.pairing_code) {
    throw new Error("no pairing code came: call connect again");
  }

  return [
    `Pairing code for +${digits}: ${pairing.pairing_code}`,
    "Tell the user to type it on that phone: WhatsApp › Settings › Linked devices › Link a device › Link with phone number instead. It expires in a few minutes; once they've typed it, call status to see the number connected (connect again for a new code).",
  ].join("\n");
}

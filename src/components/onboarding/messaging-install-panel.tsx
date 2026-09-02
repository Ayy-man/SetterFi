"use client";

import { useState } from "react";

import { Overline, Prose, Status, Surface, type Tone } from "@/components/kit/atomics";
import { DataState } from "@/components/kit/data-state";
import { LoggedButton } from "@/components/kit/logged-button";
import {
  MESSAGING_INSTALL_APPS,
  openInstallPopup,
  agencyInstallSummaryLine,
  startMessagingInstall,
  type AgencyGrantSummary,
  type MessagingInstallOutcome,
} from "./messaging-install-view-models";

const RETURN_PATH = "/admin/provisioning";

type InstallTone = "neutral" | "good" | "pending" | "bad";

/** The legacy install tones onto the kit's, per the `critical` split ruled in `LEDGER.md`. */
function tone(value: InstallTone): Tone {
  if (value === "pending") return "warning";
  if (value === "bad") return "failure";
  return value;
}

/**
 * Demo locations are counted, and they are named.
 *
 * This used to add `real` and `demo` together into one figure with no mention that any of it was
 * seeded, which is the segregation rule in `CLAUDE.md` failing quietly: an operator reading "4
 * stored client location receipts" on a workspace with three demo tenants would be reading a real
 * number for a mostly fake fact. The total still leads, because the total is what the install
 * actually stored, but the demo share is stated beside it whenever there is one.
 */
function connectedClientsState(input: { checked: boolean; realCount: number; demoCount: number }): {
  label: string;
  tone: Tone;
} {
  if (!input.checked) {
    return { label: "Stored client location receipts could not be checked", tone: "neutral" };
  }
  const count = input.realCount + input.demoCount;
  if (count === 0) {
    return { label: "No client location receipt is stored", tone: "neutral" };
  }
  const receipts = `${count} stored client location ${count === 1 ? "receipt" : "receipts"}`;
  return {
    label: input.demoCount > 0
      ? `${receipts}, ${input.demoCount} on test tenants`
      : receipts,
    tone: "good",
  };
}

function evidenceLabel(prefix: string, state: { label: string; tone: InstallTone }) {
  return `${prefix}: ${state.label}`;
}

/**
 * The warm-up warning, and it is deliberately a warning rather than a plan.
 *
 * A freshly approved account can technically send the moment the approval returns, and sending at
 * full volume on day one is how the account gets banned. That is a real state a channel passes
 * through -- and nothing in the schema can express it: `channel_connections` stores a state from a
 * fixed list (`disconnected`, `connecting`, `pending_review`, `ready`, `live`, `error`, `expired`,
 * `blocked_permanent`, `flagged`, `restricted`) plus four receipt timestamps, and none of those is
 * a warm-up. So this says what is known and what is not, rather than drawing a ramp, a percentage
 * or a day-one volume figure that no row behind it could produce.
 *
 * It sits above the install rows on purpose: a warning that only appears after the approval
 * returns is a warning about something the reader has already done.
 */
function WarmUpWarning() {
  return (
    <Surface
      className="mb-[var(--s-4)] flex flex-col gap-[var(--s-2)]"
      role="note"
      tone="warning"
    >
      <Status label="Read this before you connect" tone="warning" />
      <Prose className="m-0 text-[12.5px] leading-[1.45] text-[color:var(--warning-body)]">
        A newly approved account should not send at full volume on its first day. Sending like an
        established account from a standing start is what gets a new account restricted, and a
        restriction is not something an approval here can undo.
      </Prose>
      <Prose className="m-0 text-[12.5px] leading-[1.45] text-[color:var(--muted)]">
        SetterFi does not record a warm-up state against a connection, so nothing on this page can
        show how far into warm-up an account is, or hold sending back on its own. Treat an account
        that has just connected as not yet at full volume, and check the sending policy with your
        success owner before you raise it.
      </Prose>
    </Surface>
  );
}

/**
 * What the stored row records, as a list rather than a row of pills.
 *
 * Five facts in a pill rail would out-weigh the one state pill above it, which is the claim a
 * reader actually has to weigh. Only the facts that are something to look at carry a tone: a date
 * that reads as a date needs no colour, and colouring all five would spend the accent five times
 * on a screen allowed two.
 */
function GrantFacts({ grant }: { grant: AgencyGrantSummary | null }) {
  if (!grant || grant.facts.length === 0) return null;
  return (
    <div className="mt-[var(--s-3)]">
      <dl className="m-0 grid gap-0">
        {grant.facts.map((fact) => (
          <div
            className="flex flex-wrap items-baseline justify-between gap-x-[var(--s-4)] gap-y-[var(--s-1)] border-b border-[var(--line-soft)] py-[var(--s-2)] last:border-b-0"
            key={fact.term}
          >
            <dt className="m-0 min-w-0 text-[12.5px] leading-[1.45] text-[color:var(--muted)]">{fact.term}</dt>
            <dd className="m-0 min-w-0 text-right text-[12px] leading-[1.45] text-[color:var(--faint)]">
              {fact.tone === "pending" || fact.tone === "bad" ? (
                <Status
                  className="max-w-full whitespace-normal"
                  label={fact.value}
                  tone={tone(fact.tone)}
                  treatment="bare"
                />
              ) : fact.value}
            </dd>
          </div>
        ))}
      </dl>
      {/*
        * The consent flags are a record of one approval screen, which the column comment on
        * `approve_all_locations` says in as many words. Reading them as the provider's current
        * configuration is exactly the mistake a months-old row invites.
        */}
      <Prose className="mt-[var(--s-2)] text-[12px] leading-[1.45] text-[color:var(--faint)]">
        These are what the approval recorded when it was stored, not the provider&apos;s settings
        now. Nothing here re-reads them from the provider.
      </Prose>
    </div>
  );
}

export function MessagingInstallPanel({
  enabled,
  outcome = null,
  messagingAgencyState,
  messagingGrant = null,
  provisioningAgencyState,
  provisioningGrant = null,
  connectedClients = { real: 0, demo: 0 },
  installsChecked = false,
}: {
  enabled: boolean;
  outcome?: MessagingInstallOutcome | null;
  messagingAgencyState: { label: string; tone: InstallTone };
  provisioningAgencyState: { label: string; tone: InstallTone };
  /**
   * What the stored row says about itself, or null when the read did not complete. `stored` is the
   * row's existence rather than its health: a grant that needs re-approval is still a grant the
   * next approval replaces, so the button says reconnect for it too.
   */
  messagingGrant?: AgencyGrantSummary | null;
  provisioningGrant?: AgencyGrantSummary | null;
  connectedClients?: { real: number; demo: number };
  installsChecked?: boolean;
}) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const installsState = connectedClientsState({
    checked: installsChecked,
    realCount: connectedClients.real,
    demoCount: connectedClients.demo,
  });
  /*
   * One row's worth of derivation, done once. The displayed state is not the stored state: a grant
   * nothing has refreshed since it was written may not present itself as connected, so the pill,
   * the fill and the button all read the same freshness-aware answer rather than three of them
   * reading the raw column.
   */
  const rows = MESSAGING_INSTALL_APPS.map((entry) => {
    const agencyState = entry.app === "provisioning" ? provisioningAgencyState : messagingAgencyState;
    const grant = entry.app === "provisioning" ? provisioningGrant : messagingGrant;
    return {
      entry,
      grant,
      displayState: agencyInstallSummaryLine({ state: agencyState, facts: grant?.facts ?? [] }),
      // The row's existence, not its health. A stored grant that needs re-approval is still the
      // thing the next approval replaces, and calling that "Connect" would read as a first install.
      reconnect: grant?.stored === true || agencyState.tone === "good",
    };
  });
  /*
   * The One Fill Rule. Both install rows used to carry a filled primary, which made two live
   * actions on a page that only ever has one: the first approval that is not already stored. When
   * both credentials are stored the page spends no fill at all, which is the honest resting state
   * for a screen with nothing left to approve.
   */
  const accentApp = rows.find((row) => row.displayState.tone !== "good")?.entry.app ?? null;

  async function begin(app: (typeof MESSAGING_INSTALL_APPS)[number]["app"]) {
    setBusy((current) => ({ ...current, [app]: true }));
    setFailures((current) => ({ ...current, [app]: "" }));
    setOpened((current) => ({ ...current, [app]: false }));
    const popup = openInstallPopup((url, target) => window.open(url, target));
    const result = await startMessagingInstall({
      app,
      returnPath: RETURN_PATH,
      fetch: (url, init) => fetch(url, init),
      assign: (url) => {
        if (popup && !popup.closed) popup.location.href = url;
        else window.location.assign(url);
      },
    });
    if (result.status === "redirecting") {
      if (popup && !popup.closed) {
        setOpened((current) => ({ ...current, [app]: true }));
        setBusy((current) => ({ ...current, [app]: false }));
      }
      return;
    }
    popup?.close();
    setFailures((current) => ({ ...current, [app]: result.message }));
    setBusy((current) => ({ ...current, [app]: false }));
  }

  return (
    // The id is the anchor channel health links to, so the card that says "two apps are stored"
    // lands the reader on the rows that say what is stored rather than at the top of the page.
    <section aria-labelledby="marketplace-installs-heading" id="marketplace-installs">
      <div className="mb-[var(--s-3)]">
        <Overline as="p">Platform integrations</Overline>
        <h2
          className="mt-[var(--s-1)] text-[15px] leading-[1.3] font-[600] text-[color:var(--ink)]"
          id="marketplace-installs-heading"
        >
          Marketplace installs
        </h2>
        <Prose className="mt-[var(--s-1)] text-[12.5px] leading-[1.45] text-[color:var(--muted)]">
          Approval opens on the provider&apos;s site. Stored state and current location receipts
          remain separate evidence.
        </Prose>
      </div>

      {!enabled ? (
        <DataState
          body="Install controls will appear when marketplace approval is enabled in this environment."
          kind="empty"
          title="Marketplace installs are not enabled"
        />
      ) : (
        <>
          {outcome ? (
            <section className="mb-[var(--s-3)]" role={outcome.tone === "bad" ? "alert" : "status"}>
              {outcome.tone === "bad" ? (
                <DataState
                  body={outcome.detail}
                  kind="unavailable"
                  title={outcome.headline}
                />
              ) : (
                <div className="surface-well">
                  <h3 className="text-[13.5px] leading-[1.3] font-[500] text-[color:var(--ink)]">{outcome.headline}</h3>
                  <Prose className="mt-[var(--s-1)] text-[12.5px] leading-[1.45] text-[color:var(--muted)]">
                    {outcome.detail}
                  </Prose>
                </div>
              )}
            </section>
          ) : null}

          <WarmUpWarning />

          <Surface variant="panel">
            {rows.map(({ entry, grant, displayState, reconnect }, index) => {
              return (
                <article
                  className={index === 0 ? "p-[var(--s-4)]" : "border-t border-[var(--line-soft)] p-[var(--s-4)]"}
                  key={entry.app}
                >
                  <div className="flex flex-wrap items-start justify-between gap-[var(--s-3)]">
                    <div className="min-w-0">
                      <h3 className="text-[13.5px] leading-[1.3] font-[500] text-[color:var(--ink)]">{entry.title}</h3>
                      <Prose className="mt-[var(--s-1)] text-[12.5px] leading-[1.45] text-[color:var(--muted)]">
                        {entry.detail}
                      </Prose>
                    </div>
                    <Status
                      className="max-w-full whitespace-normal"
                      label={evidenceLabel("Stored credential read", displayState)}
                      tone={tone(displayState.tone)}
                    />
                  </div>

                  {entry.app === "agent" ? (
                    <div className="mt-[var(--s-3)] flex flex-wrap gap-[var(--s-2)]">
                      <Status className="max-w-full whitespace-normal" label={installsState.label} tone={installsState.tone} />
                    </div>
                  ) : null}

                  <GrantFacts grant={grant} />

                  {reconnect ? (
                    <Prose className="mt-[var(--s-3)] text-[12.5px] leading-[1.45] text-[color:var(--muted)]">
                      Reconnecting replaces the stored approval: the grant in use now stops being
                      used the moment the new one is stored.
                      {entry.app === "agent"
                        ? " On the approval screen, select every sub-account. Any sub-account left out of the approval does not get the messaging app."
                        : ""}
                    </Prose>
                  ) : null}

                  <div className="mt-[var(--s-3)]">
                    <LoggedButton
                      actionKey="channel.connect.started"
                      disabled={busy[entry.app]}
                      onClick={() => begin(entry.app)}
                      type="button"
                      variant={entry.app === accentApp ? "primary" : "secondary"}
                    >
                      {busy[entry.app]
                        ? "Opening approval..."
                        : reconnect
                          ? entry.app === "agent" ? "Reconnect messaging" : "Reconnect provisioning"
                          : entry.buttonLabel}
                    </LoggedButton>
                  </div>

                  {opened[entry.app] ? (
                    <section className="surface-well mt-[var(--s-3)]" role="status">
                      <h4 className="text-[13.5px] leading-[1.3] font-[500] text-[color:var(--ink)]">Approval opened in a new tab</h4>
                      <Prose className="mt-[var(--s-1)] text-[12.5px] leading-[1.45] text-[color:var(--muted)]">
                        Finish there. The callback result will appear on this page.
                      </Prose>
                    </section>
                  ) : null}
                  {failures[entry.app] ? (
                    <DataState
                      className="mt-[var(--s-3)]"
                      body={failures[entry.app]}
                      kind="unavailable"
                      title="Install could not start"
                    />
                  ) : null}
                </article>
              );
            })}
          </Surface>
        </>
      )}
    </section>
  );
}

import {
  MonoMeta,
  Overline,
  Prose,
  Status,
  Surface,
  type Tone,
} from "@/components/kit/atomics";
import { DataState } from "@/components/kit/data-state";
import { TechnicalDetail, type TechnicalDetailItem } from "@/components/kit/technical-detail";
import {
  installAppLabel,
  installAttempts,
  installEventGloss,
  type InstallAttemptOutcome,
  type InstallEventRow,
} from "./install-attempts-view-models";

/**
 * `linked` is sage rather than the legacy `info`, and the label is what stops that overclaiming.
 *
 * `STATE_TONE_TO_TONE` maps the old `info` onto `waiting`, which is periwinkle and means "the clock
 * belongs to someone else". A stored credential is not waiting on anyone, so that mapping would be
 * wrong here. Sage means live and enforced, and the worry it raises -- that a stored receipt is not
 * proof a connection still works -- is answered in words rather than in hue: the pill reads "Stored
 * at that time" and the section's own subtitle says historical storage proves nothing about now.
 * Never-Colour-Alone cuts both ways; the label is the claim.
 */
const TONES: Readonly<Record<InstallAttemptOutcome, Tone>> = {
  linked: "good",
  pending: "warning",
  declined: "failure",
  failed: "failure",
  unknown: "neutral",
};

const OUTCOME_LABELS: Readonly<Record<InstallAttemptOutcome, string>> = {
  linked: "Stored at that time",
  pending: "Approval not back yet",
  declined: "Declined",
  failed: "Did not complete",
  unknown: "Recorded result needs review",
};

function clock(createdAt: string) {
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime())) return "Time not recorded";
  return `${parsed.toISOString().slice(5, 10).replace("-", "/")} ${parsed.toISOString().slice(11, 16)} UTC`;
}

function titleCase(value: string) {
  return value.length ? `${value[0].toUpperCase()}${value.slice(1)}` : "Event";
}

export function InstallAttempts({
  rows,
  refused = false,
  unavailable = false,
}: {
  rows: readonly InstallEventRow[];
  refused?: boolean;
  unavailable?: boolean;
}) {
  const attempts = refused ? [] : installAttempts(rows);

  return (
    <section aria-labelledby="install-attempts-heading">
      <div className="mb-[var(--s-3)]">
        <Overline as="p">Install attempts</Overline>
        <h2
          className="mt-[var(--s-1)] text-[15px] leading-[1.3] font-[600] text-[color:var(--ink)]"
          id="install-attempts-heading"
        >
          Recent approval history
        </h2>
        <Prose className="mt-[var(--s-1)] text-[12.5px] leading-[1.45] text-[color:var(--muted)]">
          The ten most recent links and callbacks, newest first. Historical storage does not prove a
          connection still works now.
        </Prose>
      </div>

      {refused ? (
        <div className="flex flex-col gap-[var(--s-2)]">
          <Status label="Access not checked" tone="neutral" />
          <DataState
            body="Install history is available only to signed-in platform staff who are not viewing as a client. This is not a claim that nothing was attempted."
            kind="empty"
            title="Install history is restricted"
          />
        </div>
      ) : unavailable ? (
        <DataState
          body="The install record could not be read, so this view cannot say whether an attempt exists."
          kind="unavailable"
          title="Install history could not load"
        />
      ) : attempts.length === 0 ? (
        <DataState
          body="An approval link and its callback history will appear here after someone starts an install."
          kind="empty"
          title="No install attempts recorded"
        />
      ) : (
        <Surface variant="panel">
          {attempts.map((attempt, index) => (
            <article
              className={
                index === 0
                  ? "p-[var(--s-4)]"
                  : "border-t border-[var(--line-soft)] p-[var(--s-4)]"
              }
              key={attempt.key}
            >
              <div className="flex flex-wrap items-start justify-between gap-[var(--s-3)]">
                <div>
                  <Overline as="p">{installAppLabel(attempt.app)}</Overline>
                  <h3 className="mt-[var(--s-1)] text-[13.5px] leading-[1.3] font-[500] text-[color:var(--ink)]">
                    Approval attempt
                  </h3>
                </div>
                <Status
                  label={OUTCOME_LABELS[attempt.outcome]}
                  tone={TONES[attempt.outcome]}
                />
              </div>
              <ol className="mt-[var(--s-3)] flex flex-col gap-[var(--s-2)]">
                {attempt.events.map((event) => (
                  <li
                    className="grid gap-[var(--s-1)] sm:grid-cols-[calc(var(--s-12)*2)_minmax(0,1fr)]"
                    key={event.id}
                  >
                    <MonoMeta>{clock(event.createdAt)}</MonoMeta>
                    <span className="text-[12.5px] leading-[1.45] text-[color:var(--body)]">
                      <strong className="font-[500] text-[color:var(--ink)]">
                        {titleCase(event.step)}.
                      </strong>{" "}
                      {event.code
                        // The gloss for DRIVER_CONFIGURATION_ERROR names the missing variables, and
                        // this call site never handed it the context to do so, so the one message
                        // that could have said which configuration was missing read "unnamed".
                        ? installEventGloss(event.code, { missingEnv: event.missingEnv })
                        : "The event was recorded without an error code."}
                    </span>
                  </li>
                ))}
              </ol>
              <TechnicalDetail
                className="mt-[var(--s-3)]"
                items={[
                  ...(attempt.stateRef
                    ? [{ label: "Attempt reference", value: attempt.stateRef }]
                    : []),
                  ...attempt.events.flatMap((event, eventIndex): TechnicalDetailItem[] => [
                    { label: `Event ${eventIndex + 1} ID`, value: event.id },
                    { label: `Event ${eventIndex + 1} action`, value: event.action },
                    { label: `Event ${eventIndex + 1} timestamp`, value: event.createdAt },
                    ...(event.code
                      ? [{ label: `Event ${eventIndex + 1} code`, value: event.code }]
                      : []),
                    ...(event.missingEnv.length
                      ? [{
                        label: `Event ${eventIndex + 1} configuration`,
                        value: event.missingEnv.join(", "),
                      }]
                      : []),
                  ]),
                ]}
              />
            </article>
          ))}
        </Surface>
      )}
    </section>
  );
}

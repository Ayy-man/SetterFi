"use client";

import { useState } from "react";

import { Chip, KitButton, Overline, initialsFor } from "@/components/kit/atomics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { EditorRegion, EditorStatedRow } from "./offer-editor-chrome";

/**
 * Screen 3g, inline: who to hand a hot lead to.
 *
 * The dialog opens because something is waiting, which is why it takes the amber dot and the
 * warning edge rather than the accent one: the count in the description is the real escalation
 * count the page already reads, never a number this screen invents.
 *
 * `onConfirm` is the whole contract. A caller that has somewhere to store an owner passes one and
 * the picker commits; a caller that has not passes none, and the dialog renders the same list as
 * a roster with the truth about how a handoff resolves today stated on it. There is no third
 * behaviour where the button looks live and writes nothing.
 */

export type HandoffCandidate = {
  id: string;
  name: string;
  /** "Sales", "You". The one word under the name. */
  role: string;
  /** "replies in about 12 minutes", from measured data only. Null leaves the line off. */
  replyEta: string | null;
};

export type HandoffNotifyChannel = "sms" | "email" | "in_app";

const NOTIFY_LABELS: Record<HandoffNotifyChannel, string> = {
  sms: "Text message",
  email: "Email",
  in_app: "In app only",
};

const NOTIFY_ORDER: readonly HandoffNotifyChannel[] = ["sms", "email", "in_app"];

export type HandoffPanelProps = {
  candidates: readonly HandoffCandidate[];
  /** How many threads are waiting on a human right now. Drives the description, never invented. */
  escalationCount: number;
  /** Absent when nothing stores an owner: the picker then reads as a roster, not as a control. */
  onConfirm?: (candidateId: string) => void;
  /** The channel a handed-off thread notifies on. Stated when `onNotifyChange` is absent. */
  notify: HandoffNotifyChannel;
  onNotifyChange?: (next: HandoffNotifyChannel) => void;
  /** The owner already stored, if any. */
  ownerId: string | null;
};

export function HandoffPanel({
  candidates,
  escalationCount,
  notify,
  onConfirm,
  onNotifyChange,
  ownerId,
}: HandoffPanelProps) {
  const [selected, setSelected] = useState<string | null>(ownerId);
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? candidates.filter(
        (candidate) =>
          candidate.name.toLowerCase().includes(needle) ||
          candidate.role.toLowerCase().includes(needle),
      )
    : candidates;
  const chosen = candidates.find((candidate) => candidate.id === selected) ?? null;
  const waiting =
    escalationCount === 1
      ? "Right now 1 thread is waiting on a human."
      : `Right now ${escalationCount} threads are waiting on a human.`;

  return (
    <EditorRegion
      aside={
        <span className="text-[11.5px] leading-[1.45] text-[color:var(--meta)]">
          {onConfirm
            ? `${waiting} Pick who gets them.`
            : `${waiting} Anyone here can take one from the inbox.`}
        </span>
      }
      label="Who to hand a hot lead to"
    >
      <div className="rounded-[var(--r-well)] border border-[var(--line)] px-[18px] py-[15px]">
        {candidates.length > 4 ? (
          <div className="mb-[11px]">
            <label className="sr-only" htmlFor="handoff-search">
              Search your team
            </label>
            <Input
              id="handoff-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search your team"
              value={query}
            />
          </div>
        ) : null}

        <ul className="flex list-none flex-col gap-[7px] p-0">
          {shown.map((candidate) => {
            const active = candidate.id === selected;
            const row = (
              <>
                <span
                  aria-hidden
                  className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-[linear-gradient(150deg,var(--accent-hover),var(--accent-active))] font-[family-name:var(--font-mono)] text-[11.5px] leading-none font-medium text-[color:var(--on-accent)]"
                >
                  {initialsFor(candidate.name)}
                </span>
                <span className="min-w-0 text-left">
                  <span className="block truncate text-[13.5px] leading-[1.3] font-medium text-[color:var(--ink)]">
                    {candidate.name}
                  </span>
                  <span className="block truncate text-[11.5px] leading-[1.4] text-[color:var(--faint)]">
                    {candidate.replyEta
                      ? `${candidate.role} · ${candidate.replyEta}`
                      : candidate.role}
                  </span>
                </span>
              </>
            );

            if (!onConfirm) {
              return (
                <li
                  className="flex items-center gap-[12px] rounded-[11px] px-[12px] py-[11px]"
                  key={candidate.id}
                >
                  {row}
                </li>
              );
            }

            return (
              <li key={candidate.id}>
                <Button
                  aria-pressed={active}
                  className={`flex h-auto w-full items-center justify-start gap-[12px] rounded-[11px] px-[12px] py-[11px] text-left ${
                    active
                      ? "border border-[var(--accent-edge)] bg-[var(--accent-wash)]"
                      : "border border-transparent hover:border-[var(--line)]"
                  }`}
                  onClick={() => setSelected(candidate.id)}
                  type="button"
                  variant="ghost"
                >
                  {row}
                  <span
                    aria-hidden
                    className={`ml-auto flex size-[19px] shrink-0 items-center justify-center rounded-full ${
                      active
                        ? "border border-[var(--accent-line)] bg-[var(--accent-bright)]"
                        : "border-[1.5px] border-[var(--line-input)]"
                    }`}
                  >
                    {active ? (
                      <span className="size-[7px] rounded-full bg-[var(--canvas)]" />
                    ) : null}
                  </span>
                </Button>
              </li>
            );
          })}
        </ul>

        {shown.length === 0 ? (
          <p className="py-[11px] text-[12.5px] leading-[1.5] text-[color:var(--dim)]">
            Nobody on your team matches that.
          </p>
        ) : null}

        <div className="mt-[14px] rounded-[11px] border border-[var(--line)] bg-[var(--well)] px-[14px] py-[13px]">
          <Overline className="mb-[11px] block">How they find out</Overline>
          <div className="flex flex-wrap gap-[7px]">
            {NOTIFY_ORDER.map((channel) =>
              onNotifyChange ? (
                <KitButton
                  aria-pressed={channel === notify}
                  key={channel}
                  onClick={() => onNotifyChange(channel)}
                  size="sm"
                  variant={channel === notify ? "soft" : "secondary"}
                >
                  {NOTIFY_LABELS[channel]}
                </KitButton>
              ) : (
                <Chip key={channel} selected={channel === notify}>
                  {NOTIFY_LABELS[channel]}
                </Chip>
              ),
            )}
          </div>
          <div className="mt-[12px] border-t border-[var(--line-soft)] pt-[4px]">
            <EditorStatedRow
              detail="A handed-off thread stops the agent and waits. We keep the lead warm and nothing auto-replies in your name."
              title="While it waits"
              value="agent paused"
            />
          </div>
        </div>

        <div className="mt-[14px] flex flex-wrap items-center gap-[9px] border-t border-[var(--line-soft)] pt-[13px]">
          {/*
            The one verb that commits. `KitButton` primary at `lg` is the same face as the page's
            own `ACCENT_FILL_CLASS` -- 34px, 9px radius, 15px gutter, 13px semibold on
            `--accent-fill`, same inset highlight and same accent floor -- so a coach who followed
            the card's accent into its editor lands on the same object. The local constant this
            replaces had drifted to 32px/12.5px, so the kit is a closer match than what was here.
          */}
          {onConfirm ? (
            <KitButton
              disabled={!chosen}
              onClick={() => {
                if (chosen) onConfirm(chosen.id);
              }}
              size="lg"
              variant="primary"
            >
              {chosen ? `Set ${chosen.name.split(" ")[0]} as owner` : "Pick someone first"}
            </KitButton>
          ) : (
            <span className="text-[12px] leading-[1.45] text-[color:var(--faint)]">
              A thread stays with whoever opens it in the inbox. There is no standing owner to set
              yet.
            </span>
          )}
        </div>
      </div>
    </EditorRegion>
  );
}

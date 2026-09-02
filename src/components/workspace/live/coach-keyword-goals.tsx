"use client";

import { useEffect, useMemo, useState } from "react";

import { ExportMenu } from "@/components/kit/export-menu";
import { Field } from "@/components/kit/field";
import { LoggedButton } from "@/components/kit/logged-button";
import { SegmentedControl } from "@/components/kit/segmented-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { KeywordGoal, KeywordGoalMode } from "@/lib/repositories/keyword-goals";
import { cn } from "@/lib/utils";

type Draft = {
  id: string | null;
  keyword: string;
  goal: KeywordGoalMode;
  resourceUrl: string;
  resourceMessage: string;
  postBookingUrl: string;
  postBookingMessage: string;
  active: boolean;
};

const EMPTY_DRAFT: Draft = {
  id: null,
  keyword: "",
  goal: "resource",
  resourceUrl: "",
  resourceMessage: "",
  postBookingUrl: "",
  postBookingMessage: "",
  active: true,
};

function toDraft(goal: KeywordGoal): Draft {
  return {
    id: goal.id,
    keyword: goal.keyword,
    goal: goal.goal,
    resourceUrl: goal.resourceUrl ?? "",
    resourceMessage: goal.resourceMessage ?? "",
    postBookingUrl: goal.postBookingUrl ?? "",
    postBookingMessage: goal.postBookingMessage ?? "",
    active: goal.active,
  };
}

function secureUrl(value: string) {
  if (!value.trim()) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validate(draft: Draft) {
  if (!draft.keyword.trim()) return "Add the trigger keyword.";
  if (draft.keyword.trim().length > 120) return "Keep the trigger keyword to 120 characters or fewer.";
  if (draft.goal === "resource" && !draft.resourceUrl.trim()) {
    return "Add a secure resource link before saving.";
  }
  if (!secureUrl(draft.resourceUrl) || !secureUrl(draft.postBookingUrl)) {
    return "Links must start with https:// and cannot include sign-in details.";
  }
  if (draft.resourceMessage.length > 1_000 || draft.postBookingMessage.length > 1_000) {
    return "Keep each optional message to 1,000 characters or fewer.";
  }
  return null;
}

type Props = {
  /** Test/server hydration seam. Omit to load from the tenant-scoped route. */
  initialGoals?: readonly KeywordGoal[];
};

/** Isolated until Alec rules where this section belongs relative to the four Agent cards. */
export function CoachKeywordGoals({ initialGoals }: Props) {
  const [goals, setGoals] = useState<readonly KeywordGoal[] | null>(initialGoals ?? null);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(() => initialGoals?.[0]
    ? toDraft(initialGoals[0])
    : null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (initialGoals !== undefined) return;
    let alive = true;
    void fetch("/api/coach/keyword-goals", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("KEYWORD_GOALS_LOAD_FAILED");
        const value: unknown = await response.json();
        if (!value || typeof value !== "object" || !Array.isArray((value as { goals?: unknown }).goals)) {
          throw new Error("KEYWORD_GOALS_LOAD_FAILED");
        }
        const loaded = (value as { goals: KeywordGoal[] }).goals;
        if (alive) {
          setGoals(loaded);
          setDraft(loaded[0] ? toDraft(loaded[0]) : null);
        }
      })
      .catch(() => { if (alive) setLoadError(true); });
    return () => { alive = false; };
  }, [initialGoals]);

  const selectedId = draft?.id ?? null;
  const sortedGoals = useMemo(() => [...(goals ?? [])].sort((left, right) =>
    Number(right.active) - Number(left.active) || left.keyword.localeCompare(right.keyword)), [goals]);

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setError(null);
    setNotice(null);
  }

  async function save() {
    if (!draft) return;
    const validation = validate(draft);
    if (validation) {
      setError(validation);
      throw new Error("KEYWORD_GOAL_VALIDATION_FAILED");
    }
    setError(null);
    setNotice(null);
    const response = await fetch("/api/coach/keyword-goals", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: draft.id,
        keyword: draft.keyword.trim(),
        goal: draft.goal,
        resourceUrl: draft.goal === "resource" ? draft.resourceUrl.trim() || null : null,
        resourceMessage: draft.goal === "resource" ? draft.resourceMessage.trim() || null : null,
        postBookingUrl: draft.postBookingUrl.trim() || null,
        postBookingMessage: draft.postBookingMessage.trim() || null,
      }),
    });
    const value: unknown = await response.json().catch(() => null);
    const payload = value as { goal?: KeywordGoal; audit?: { actionKey?: string; auditId?: string } } | null;
    if (!response.ok || !payload?.goal || payload.audit?.actionKey !== "keyword_goal.saved" ||
      !payload.audit.auditId) {
      setError("This keyword goal was not saved. Try again.");
      throw new Error("KEYWORD_GOAL_SAVE_REFUSED");
    }
    setGoals((current) => [
      ...(current ?? []).filter((goal) => goal.id !== payload.goal!.id),
      payload.goal!,
    ]);
    setDraft(toDraft(payload.goal));
    setNotice("Saved and logged.");
  }

  async function deactivate() {
    if (!draft?.id) return;
    setError(null);
    setNotice(null);
    const response = await fetch("/api/coach/keyword-goals", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: draft.id }),
    });
    const value: unknown = await response.json().catch(() => null);
    const payload = value as { goal?: KeywordGoal; audit?: { actionKey?: string; auditId?: string } } | null;
    if (!response.ok || !payload?.goal || payload.audit?.actionKey !== "keyword_goal.deactivated" ||
      !payload.audit.auditId || payload.goal.active) {
      setError("This keyword goal was not deactivated. Try again.");
      throw new Error("KEYWORD_GOAL_DEACTIVATE_REFUSED");
    }
    setGoals((current) => (current ?? []).map((goal) => goal.id === payload.goal!.id
      ? payload.goal!
      : goal));
    setDraft(toDraft(payload.goal));
    setNotice("Deactivated and logged.");
  }

  return (
    <section
      aria-labelledby="keyword-goals-heading"
      className="flex min-w-0 flex-col gap-[var(--s-5)] rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)] p-[var(--s-5)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-[var(--s-3)]">
        <div className="max-w-3xl">
          <h2 className="text-[24px] font-semibold leading-tight text-[var(--ink)]" id="keyword-goals-heading">
            Keyword goals
          </h2>
          <p className="mt-[var(--s-1)] text-[16px] leading-7 text-[var(--muted)]">
            Choose what happens when a lead sends each trigger word.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-[var(--s-2)]">
          <ExportMenu
            filename="setterfi-keyword-goals"
            label="Export keyword goals"
            mode="server"
            resource="keyword-goals"
          />
          <Button
            className="min-h-[48px] rounded-[9px] px-[24px] text-[16px]"
            onClick={() => {
              setDraft({ ...EMPTY_DRAFT });
              setError(null);
              setNotice(null);
            }}
            type="button"
            variant="secondary"
          >
            Add keyword
          </Button>
        </div>
      </div>

      <p
        className="rounded-[var(--r-input)] bg-[var(--quiet)] p-[var(--s-3)] text-[15px] leading-6 text-[var(--muted)]"
        data-testid="keyword-goal-conversion-copy"
      >
        SetterFi measures qualified leads with <strong>QualifiedLead</strong> and confirmed bookings
        with <strong>Purchase</strong>. The account owner creates any custom labels in Ads Manager.
        Messenger and WhatsApp click-to-message ads can use these events for optimization; Instagram
        provides measurement, not ad optimization.
      </p>

      {goals === null && !loadError ? <p role="status">Loading keyword goals…</p> : null}
      {loadError ? <p className="text-[var(--danger)]" role="alert">Keyword goals could not load. Try again.</p> : null}
      {goals?.length === 0 && !draft ? (
        <div className="rounded-[var(--r-input)] border border-dashed border-[var(--line)] p-[var(--s-5)]">
          <p className="text-[18px] font-medium text-[var(--ink)]">No keyword goals yet</p>
          <p className="mt-[var(--s-1)] text-[15px] text-[var(--muted)]">Add a trigger when you are ready.</p>
        </div>
      ) : null}

      {sortedGoals.length > 0 ? (
        <ul aria-label="Saved keyword goals" className="flex flex-wrap gap-[var(--s-2)]">
          {sortedGoals.map((goal) => (
            <li key={goal.id}>
              <button
                aria-pressed={selectedId === goal.id}
                className={cn(
                  "min-h-[48px] rounded-[var(--r-input)] border px-[var(--s-3)] text-left text-[16px]",
                  selectedId === goal.id
                    ? "border-[var(--ink)] bg-[var(--quiet)] text-[var(--ink)]"
                    : "border-[var(--line)] text-[var(--muted)]",
                )}
                onClick={() => { setDraft(toDraft(goal)); setError(null); setNotice(null); }}
                type="button"
              >
                {goal.keyword}{goal.active ? "" : " · inactive"}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {draft ? (
        <div className="grid gap-[var(--s-4)] rounded-[var(--r-input)] border border-[var(--line)] p-[var(--s-4)]">
          <Field htmlFor="keyword-goal-trigger" label="Trigger keyword" required>
            <Input
              aria-label="Trigger keyword"
              className="min-h-[48px] text-[16px]"
              maxLength={120}
              onChange={(event) => update("keyword", event.target.value)}
              value={draft.keyword}
            />
          </Field>

          <div>
            <p className="mb-[var(--s-2)] text-[16px] font-medium text-[var(--ink)]">What should happen first?</p>
            <SegmentedControl
              ariaLabel="Keyword goal"
              onValueChange={(value) => update("goal", value as KeywordGoalMode)}
              scale="coach"
              segments={[
                { key: "resource", label: "Send a resource first" },
                { key: "book", label: "Go straight to booking" },
              ]}
              value={draft.goal}
            />
          </div>

          {draft.goal === "resource" ? (
            <>
              <Field htmlFor="keyword-goal-resource-url" label="Resource link" required>
                <Input
                  aria-label="Resource link"
                  className="min-h-[48px] text-[16px]"
                  inputMode="url"
                  onChange={(event) => update("resourceUrl", event.target.value)}
                  placeholder="https://"
                  value={draft.resourceUrl}
                />
              </Field>
              <Field htmlFor="keyword-goal-resource-message" label="Resource message (optional)" hint="Sent before the resource link.">
                <Textarea
                  aria-label="Resource message (optional)"
                  className="min-h-[112px] text-[16px]"
                  maxLength={1_000}
                  onChange={(event) => update("resourceMessage", event.target.value)}
                  value={draft.resourceMessage}
                />
              </Field>
            </>
          ) : null}

          <Field htmlFor="keyword-goal-post-booking-url" label="Post-booking link (optional)" hint="A thank-you or invite page sent after the booking is confirmed.">
            <Input
              aria-label="Post-booking link (optional)"
              className="min-h-[48px] text-[16px]"
              inputMode="url"
              onChange={(event) => update("postBookingUrl", event.target.value)}
              placeholder="https://"
              value={draft.postBookingUrl}
            />
          </Field>
          <Field htmlFor="keyword-goal-post-booking-message" label="Post-booking message (optional)">
            <Textarea
              aria-label="Post-booking message (optional)"
              className="min-h-[112px] text-[16px]"
              maxLength={1_000}
              onChange={(event) => update("postBookingMessage", event.target.value)}
              value={draft.postBookingMessage}
            />
          </Field>

          {error ? <p className="text-[15px] text-[var(--danger)]" role="alert">{error}</p> : null}
          {notice ? <p className="text-[15px] text-[var(--success)]" role="status">{notice}</p> : null}
          <div className="flex flex-wrap items-start gap-[var(--s-3)]">
            <LoggedButton actionKey="keyword_goal.saved" onClick={save} scale="coach" variant="primary">
              Save keyword
            </LoggedButton>
            {draft.id && draft.active ? (
              <LoggedButton actionKey="keyword_goal.deactivated" onClick={deactivate} scale="coach" variant="secondary">
                Deactivate keyword
              </LoggedButton>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

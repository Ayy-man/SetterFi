"use client";

/**
 * The account-terms registry, stated rather than implied.
 *
 * SetterFi does not write the contract a coach signs; the client's counsel does. So this screen
 * carries no legal copy of its own and never claims a document exists. It says one of two things:
 * nothing is published and signup therefore records no acceptance, or this exact version is, with
 * its key, its hash, and the day it went in.
 *
 * There is no unpublish control because there is no unpublish. `account_terms_versions` holds one
 * published row behind a partial unique index and has no column that could record a withdrawal, so
 * a second publication is refused by the database and that refusal is shown in words.
 */

import { useState, type FormEvent } from "react";

import {
  KitButton,
  KitInput,
  Overline,
  Prose,
  SettingGroup,
  SettingRow,
  Status,
  Surface,
} from "@/components/kit/atomics";
import { Callout, type CalloutTone } from "@/components/kit/callout";
import { CopyValue } from "@/components/kit/copy-value";
import { Field } from "@/components/kit/field";
import { FileText, ShieldCheck } from "@/components/kit/icons";
import { PageHeader } from "@/components/kit/page-header";
import { Textarea } from "@/components/ui/textarea";
import { workspaceDateTimeYearFormat } from "@/lib/format/datetime";

export type AccountTermsVersionView = {
  versionKey: string;
  contentHash: string;
  createdAt: string;
  publishedAt: string | null;
};

export type AdminAccountTermsProps = {
  published: AccountTermsVersionView | null;
  drafts: readonly AccountTermsVersionView[];
  /** Whether the signup and read side is armed. The publisher works either way, and says which. */
  acceptanceLive: boolean;
  /** Set when the registry itself could not be read, so the page states that instead of "none". */
  readError?: string | null;
};

type Feedback = { tone: CalloutTone; title: string; body: string; auditId?: string };

const CRUMBS = [{ label: "Platform", href: "/admin/audit" }, { label: "Account terms" }] as const;

const PAGE_DESCRIPTION =
  "The contract a coach accepts at signup. SetterFi stores the approved copy and the hash of it; it never writes the copy.";

function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : workspaceDateTimeYearFormat.format(date);
}

function shortHash(value: string) {
  return `${value.slice(0, 12)}...`;
}

async function postRegistryChange(body: Record<string, unknown>) {
  const response = await fetch("/api/admin/account-terms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  const message = payload && typeof payload === "object" && "error" in payload
    ? String((payload as { error: unknown }).error)
    : "The account terms registry could not be reached.";
  if (!response.ok) throw new Error(message);
  return payload as { auditId?: string };
}

export function AdminAccountTermsHeader() {
  return <PageHeader crumbs={CRUMBS} description={PAGE_DESCRIPTION} title="Account terms" />;
}

export function AdminAccountTerms({
  acceptanceLive,
  drafts,
  published,
  readError = null,
}: AdminAccountTermsProps) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [versionKey, setVersionKey] = useState("");
  const [termsBody, setTermsBody] = useState("");
  const [privacyBody, setPrivacyBody] = useState("");

  async function submitDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("draft");
    setFeedback(null);
    try {
      const receipt = await postRegistryChange({
        action: "draft",
        versionKey: versionKey.trim(),
        termsBody,
        privacyBody,
      });
      setVersionKey("");
      setTermsBody("");
      setPrivacyBody("");
      setFeedback({
        tone: "good",
        title: "Draft saved",
        body: "The draft is stored and hashed. Nothing a coach sees changes until it is published.",
        auditId: receipt.auditId,
      });
    } catch (error) {
      setFeedback({
        tone: "critical",
        title: "The draft was refused",
        body: error instanceof Error ? error.message : "The draft could not be saved.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function publish(version: AccountTermsVersionView) {
    setBusy(version.versionKey);
    setFeedback(null);
    try {
      const receipt = await postRegistryChange({
        action: "publish",
        versionKey: version.versionKey,
        contentHash: version.contentHash,
      });
      setFeedback({
        tone: "good",
        title: `Published ${version.versionKey}`,
        body: acceptanceLive
          ? "Signup now asks every new coach to accept this version."
          : "Signup still records no acceptance: SETTERFI_ACCOUNT_TERMS_LIVE is off. Switching it on arms this version.",
        auditId: receipt.auditId,
      });
    } catch (error) {
      setFeedback({
        tone: "critical",
        title: "The publication was refused",
        body: error instanceof Error ? error.message : "The version could not be published.",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-[var(--s-5)]">
      <AdminAccountTermsHeader />

      {feedback ? (
        <div aria-live={feedback.tone === "critical" ? "assertive" : "polite"}>
          <Callout body={feedback.body} title={feedback.title} tone={feedback.tone} />
          {feedback.auditId ? (
            <p className="t-faint mt-[var(--s-2)]" data-slot="account-terms-receipt">
              Logged after server confirmation, audit receipt #{feedback.auditId}
            </p>
          ) : null}
        </div>
      ) : null}

      <Surface as="section" data-slot="account-terms-state">
        <Overline as="p">Registry</Overline>
        {readError ? (
          <Prose className="mt-[var(--s-2)] text-[12.5px] leading-[1.45] text-[color:var(--muted)]">
            {readError}
          </Prose>
        ) : published ? (
          <div className="mt-[var(--s-2)] flex flex-col gap-[var(--s-3)]">
            <div className="flex flex-wrap items-center gap-[var(--s-3)]">
              <h2 className="t-section-title m-0">{published.versionKey}</h2>
              <Status label="Published" tone="good" />
            </div>
            <Prose className="text-[12.5px] leading-[1.45] text-[color:var(--muted)]">
              Published {displayTime(published.publishedAt ?? published.createdAt)}.{" "}
              {acceptanceLive
                ? "Signup asks every new coach to accept this version."
                : "Signup records no acceptance yet: SETTERFI_ACCOUNT_TERMS_LIVE is off."}{" "}
              A published version cannot be edited, replaced, or withdrawn here.
            </Prose>
            {/*
              The hash in full, not a prefix. It is the value counsel and an auditor compare
              against the approved document, and a truncated one cannot be compared.
            */}
            <div className="flex items-center gap-[var(--s-2)]">
              <code className="t-id break-all" data-slot="account-terms-hash">{published.contentHash}</code>
              <CopyValue label="content hash" value={published.contentHash} />
            </div>
          </div>
        ) : (
          <Prose className="mt-[var(--s-2)] text-[12.5px] leading-[1.45] text-[color:var(--muted)]">
            No terms are published. Signup records no acceptance until a version is published.
          </Prose>
        )}
      </Surface>

      <section className="flex flex-col gap-[var(--s-3)]" data-slot="account-terms-drafts">
        <Overline as="p">Drafts</Overline>
        {drafts.length === 0 ? (
          <Prose className="text-[12.5px] leading-[1.45] text-[color:var(--muted)]">
            No drafts are waiting. A draft is stored copy that nobody has been asked to accept.
          </Prose>
        ) : (
          <SettingGroup>
            {drafts.map((draft) => (
              <SettingRow
                align="start"
                control={
                  <span className="flex flex-col items-end gap-[var(--s-1)]">
                    <KitButton
                      disabled={busy !== null || published !== null}
                      onClick={() => void publish(draft)}
                      type="button"
                      variant="primary"
                    >
                      {busy === draft.versionKey ? "Publishing" : "Publish"}
                    </KitButton>
                    <span className="t-faint">Publication is logged</span>
                  </span>
                }
                description={
                  published
                    ? `Saved ${displayTime(draft.createdAt)}. A version is already published, so this draft cannot be published over it.`
                    : `Saved ${displayTime(draft.createdAt)}. Hash ${shortHash(draft.contentHash)}.`
                }
                icon={<FileText />}
                iconTone="neutral"
                key={draft.versionKey}
                title={draft.versionKey}
              />
            ))}
          </SettingGroup>
        )}
      </section>

      <Surface as="section" data-slot="account-terms-draft-form">
        <Overline as="p">New draft</Overline>
        <Prose className="mt-[var(--s-2)] mb-[var(--s-4)] text-[12.5px] leading-[1.45] text-[color:var(--muted)]">
          Paste the approved terms and privacy copy exactly as counsel supplied it. The hash is
          computed from these two bodies and is what an acceptance is recorded against.
        </Prose>
        <form className="flex flex-col gap-[var(--s-4)]" onSubmit={(event) => void submitDraft(event)}>
          <Field
            hint="How this version is named in the audit log and in every acceptance record."
            label="Version key"
            required
          >
            <KitInput
              maxLength={128}
              name="versionKey"
              onChange={(event) => setVersionKey(event.target.value)}
              required
              value={versionKey}
            />
          </Field>
          <Field label="Terms of service" required>
            <Textarea
              name="termsBody"
              onChange={(event) => setTermsBody(event.target.value)}
              required
              rows={10}
              value={termsBody}
            />
          </Field>
          <Field label="Privacy policy" required>
            <Textarea
              name="privacyBody"
              onChange={(event) => setPrivacyBody(event.target.value)}
              required
              rows={10}
              value={privacyBody}
            />
          </Field>
          <div className="flex items-center justify-end gap-[var(--s-3)]">
            <span className="t-faint inline-flex items-center gap-[var(--s-1)]">
              <ShieldCheck aria-hidden className="size-[var(--s-3)]" />
              Saving a draft is logged
            </span>
            <KitButton
              disabled={busy !== null || !versionKey.trim() || !termsBody.trim() || !privacyBody.trim()}
              type="submit"
              variant="secondary"
            >
              {busy === "draft" ? "Saving draft" : "Save draft"}
            </KitButton>
          </div>
        </form>
      </Surface>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";

import { CoachScale } from "@/components/coach-scale";
import {
  Prose,
  StatusDot,
  Surface,
  TONE_LINE,
  TONE_TEXT,
  TONE_WASH,
  type Tone,
} from "@/components/kit/atomics";
import { TechnicalDetail } from "@/components/kit/technical-detail";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  artifactDescriptor as messagingTermsDescriptor,
  hostedConsentSubmission,
  type HostedArtifactView,
} from "@/components/onboarding/view-models";

type OptinArtifactProps = {
  enabled: boolean;
  tenantSlug: string;
  artifact: HostedArtifactView | null;
  page: "consent" | "terms" | "privacy";
  consentToken?: string | null;
};

/**
 * The three pages a lead sees, and the only surfaces in the product that carry the coach's brand
 * rather than SetterFi's.
 *
 * Two things constrain the layout in ways a console screen is not constrained. First, the words are
 * evidence: this markup renders the copy filed for A2P 10DLC carrier registration, so typography,
 * hierarchy and spacing are the only things here that may move. Second, the reader is a consumer on
 * whatever device and connection they happen to have, so every run of text is capped by the Line
 * Length rule -- the terms body previously ran the full 3xl container at whatever the viewport gave
 * it, which is the one legibility defect on a legal page that actually costs a reader comprehension.
 *
 * The identity block is deliberately the coach's business name over the document title, in that
 * order. SetterFi is not named anywhere on these pages and must not be: a lead consenting to
 * messages from their coach is not consenting to a platform they have never heard of.
 */

/**
 * The document title role, which is the coach language's page title rather than the console's.
 *
 * These pages used `--t-title`, and every `--t-*` value is an absolute pixel size belonging to the
 * owner console -- so the one surface in the product read by a stranger on a phone was set at the
 * density built for the client's own team using a mouse all day. `CoachScale` puts the whole page
 * in the 16px / 46px column `docs/REDESIGN-CANVAS.md` assigns to "coach, affiliate, consumer,
 * onboarding", and this is that column's title.
 */
const DOC_TITLE_CLASS =
  "mt-[var(--s-2)] text-[length:var(--coach-page-title)] leading-[1.05] font-[500] tracking-[-0.026em] text-[color:var(--ink)]";

/**
 * The reading size for a legal document. These pages are read once, carefully, by someone who is
 * not a user of this product and who may be reading outdoors one-handed, so they get the coach
 * body size rather than the console's 13px row.
 */
const DOC_BODY_CLASS =
  "text-[length:var(--coach-body)] leading-[1.6] text-[color:var(--body)]";

/**
 * The eyebrow above the document title -- the coach's business name, and the white-label identity
 * of the whole page.
 *
 * It was an `Overline`, which is the 9.5px uppercase mono role. That role is the console's, and it
 * is the single worst legibility case the redesign set out to remove; a business name is also
 * exactly the wrong content for it, because uppercasing a proper noun at 9.5px takes the one word
 * on the page that has to be recognised instantly and makes it the hardest to read. Sentence case
 * at 12px is the coach panel's eyebrow, and the name arrives as itself.
 */
const DOC_EYEBROW_CLASS =
  "m-0 text-[length:var(--coach-eyebrow)] leading-[1.4] text-[color:var(--muted)]";

/**
 * The quiet link. These pages spend their one accent on the submit fill, so the cross-links between
 * the three documents read as links by their underline rather than by colour -- which is also the
 * rule about never carrying a distinction by hue alone, applied to the one surface where a reader
 * with low vision on a phone in daylight is the expected case rather than the edge case.
 */
const DOC_LINK_CLASS =
  "text-[color:var(--body)] underline decoration-[var(--line-strong)] underline-offset-[3px] hover:decoration-[var(--ink)] hover:text-[color:var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] rounded-[var(--r-control)]";

/**
 * A tinted notice that wraps.
 *
 * The kit's `Status` pill is the right visual, but it is `whitespace-nowrap` with a `truncate` on
 * its own label span, which is correct in a table cell and wrong here: every sentence this surface
 * shows is a full sentence, and two of them -- "Demo-only placeholder, not production legal copy"
 * and the no-consent outcome -- would ellipsize on a phone. A legal marker or a consent receipt
 * that is cut off mid-word is worse than no marker at all, so this spends the same tone tokens the
 * pill does and lets the text run to as many lines as it needs.
 *
 * It is local rather than a new atomic on purpose: widening the shared pill is a kit decision, and
 * this lane does not own the kit.
 */
function Notice({
  children,
  className,
  tone,
  ...rest
}: { className?: string; tone: Tone } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`flex items-start gap-[var(--s-2)] rounded-[var(--r-well)] border px-[var(--s-3)] py-[var(--s-2)] text-[length:var(--coach-body)] leading-[1.5] font-[500] ${className ?? ""}`}
      data-tone={tone}
      style={{ background: TONE_WASH[tone], borderColor: TONE_LINE[tone], color: TONE_TEXT[tone] }}
      {...rest}
    >
      <StatusDot className="mt-[6px]" size={6} tone={tone} />
      <Prose as="span" measure="prose">{children}</Prose>
    </div>
  );
}

function DocumentShell({ children }: { children: React.ReactNode }) {
  return (
    <CoachScale
      as="main"
      className="min-h-dvh bg-[var(--canvas)] px-[var(--s-4)] py-[var(--s-8)] text-[color:var(--ink)]"
    >
      {/*
        The deck panel's asymmetric radius -- larger on top -- rather than the console's even
        `--r-card`. It is the one shape the coach side has, and a lead who lands here from a text
        message and later signs in should not meet two different products.
      */}
      <Surface className="mx-auto w-full max-w-3xl rounded-[var(--coach-panel-radius)] p-[var(--s-6)]">
        {children}
      </Surface>
    </CoachScale>
  );
}

/** Business name over document title. The eyebrow is the white-label identity, never a label. */
function DocumentHead({ businessName, title }: { businessName: string | null; title: string }) {
  return (
    <header>
      {businessName ? <p className={DOC_EYEBROW_CLASS}>{businessName}</p> : null}
      <h1 className={DOC_TITLE_CLASS}>{title}</h1>
    </header>
  );
}

export function OptinArtifact({ enabled, tenantSlug, artifact, page, consentToken }: OptinArtifactProps) {
  const [marketing, setMarketing] = useState(false);
  const [nonMarketing, setNonMarketing] = useState(false);
  // The outcome carries its own tone rather than being read back out of the sentence: a lead who
  // ticked nothing and a lead whose submission was refused are two different results, and a reader
  // scanning for "did that work" should not have to parse the sentence to find out.
  const [result, setResult] = useState<{ tone: Tone; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [conversationReady, setConversationReady] = useState(false);

  const missingPageBody = artifact && (
    (page === "terms" && !artifact.termsBody)
    || (page === "privacy" && !artifact.privacyBody)
  );
  const base = `/opt-in/${tenantSlug}`;
  // Only the artifact carries a verified business name. A slug is routing data, not identity:
  // title-casing it would present an unverified guess as the coach's name on a public page.
  const businessName = artifact?.businessName ?? null;

  if (!enabled || !artifact || missingPageBody || (artifact.placeholder && !artifact.isDemo)) {
    const missingDocument = page === "privacy"
      ? "privacy policy"
      : page === "terms"
        ? "terms"
        : "messaging terms";
    return (
      <CoachScale
        as="main"
        className="grid min-h-dvh place-items-center bg-[var(--canvas)] px-[var(--s-4)] py-[var(--s-8)] text-[color:var(--ink)]"
      >
        <Surface className="w-full max-w-2xl rounded-[var(--coach-panel-radius)] p-[var(--s-6)]">
          <DocumentHead
            businessName={businessName ?? (page === "privacy" ? "Privacy policy" : page === "terms" ? "Terms" : "Messaging terms")}
            title={page === "privacy" ? "Privacy policy not published" : page === "terms" ? "Terms not published" : "Messaging choices not published"}
          />
          <Prose className={`mt-[var(--s-4)] ${DOC_BODY_CLASS}`}>
            This business has not published its {missingDocument} yet.
          </Prose>
          <div className="mt-[var(--s-6)]">
            {page === "consent" ? (
              <Button render={<Link href="/" />} variant="outline">
                Return home
              </Button>
            ) : (
              <Button render={<Link href={base} />} variant="outline">
                Back to messaging choices
              </Button>
            )}
          </div>
        </Surface>
      </CoachScale>
    );
  }

  const descriptor = messagingTermsDescriptor(artifact);
  const technicalItems = [
    { label: "Template version", value: descriptor.templateVersion },
    { label: "Document checksum", value: artifact.artifactHash },
  ];

  if (page === "terms" || page === "privacy") {
    const body = page === "terms" ? artifact.termsBody! : artifact.privacyBody!;
    const bodyHash = page === "terms" ? artifact.termsBodyHash : artifact.privacyBodyHash;
    return (
      <DocumentShell>
        <DocumentHead businessName={artifact.businessName} title={page === "terms" ? "Terms" : "Privacy policy"} />
        {descriptor.demoOnly ? (
          <Notice className="mt-[var(--s-4)]" tone="warning">Demo-only placeholder</Notice>
        ) : null}
        {/*
          The document itself. `wide` rather than `prose` because it owns the whole card and has no
          neighbour to sit beside, and `whitespace-pre-wrap` because the filed copy carries its own
          paragraph breaks and this markup must not reflow them.
        */}
        <Prose
          as="div"
          className={`mt-[var(--s-6)] whitespace-pre-wrap ${DOC_BODY_CLASS}`}
          measure="wide"
        >
          {body}
        </Prose>
        <TechnicalDetail
          className="mt-[var(--s-6)]"
          items={[...technicalItems, { label: "Body checksum", value: bodyHash ?? "Not recorded" }]}
        />
        <Button className="mt-[var(--s-6)]" render={<Link href={base} />} variant="outline">
          Back to messaging choices
        </Button>
      </DocumentShell>
    );
  }

  async function submit() {
    if (!artifact) return;
    setSubmitting(true);
    setResult(null);
    try {
      const response = await fetch(`/api/opt-in/${tenantSlug}/consent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(hostedConsentSubmission({
          artifactId: artifact.artifactId,
          marketing,
          nonMarketing,
          consentToken,
        })),
      });
      const payload: unknown = await response.json();
      if (!response.ok || !payload || typeof payload !== "object" || !("outcome" in payload)) {
        setResult({ tone: "failure", text: "The submission was refused. Nothing was recorded." });
        return;
      }
      // Submitting with neither option ticked used to report the same success as a real consent,
      // so a lead who chose nothing was told their choices were submitted while the route had
      // stored no evidence at all. The two outcomes now say which one happened.
      const { outcome } = payload as { outcome: unknown };
      if (outcome === "consent_recorded") {
        setResult({ tone: "good", text: "Your choices were recorded." });
        setConversationReady(Boolean(consentToken));
        return;
      }
      if (outcome === "no_consent_selected") {
        setResult({
          tone: "warning",
          text: "You selected neither option, so nothing was recorded. You can tick a choice and submit again.",
        });
        return;
      }
      setResult({ tone: "failure", text: "The submission was refused. Nothing was recorded." });
    } catch {
      setResult({ tone: "failure", text: "The submission was refused. Nothing was recorded." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DocumentShell>
      <DocumentHead businessName={artifact.businessName} title="Messaging choices" />
      {descriptor.demoOnly ? (
        <Notice className="mt-[var(--s-4)]" tone="warning">Demo-only placeholder, not production legal copy</Notice>
      ) : null}
      <form action={submit} className="mt-[var(--s-6)] grid gap-[var(--s-3)]">
        {[{ checked: marketing, control: descriptor.controls[0], onChange: setMarketing }, { checked: nonMarketing, control: descriptor.controls[1], onChange: setNonMarketing }].map(({ checked, control, onChange }) => (
          // A well rather than a tinted block: the consent language is the content of the page, so
          // it sits in the recessed region the rest of the product uses for a thing being read,
          // and the checkbox is the only thing in the row a lead can move.
          <Surface
            as="label"
            className={`flex cursor-pointer items-start gap-[var(--s-3)] ${DOC_BODY_CLASS}`}
            key={control.key}
            variant="well"
          >
            <Checkbox
              aria-labelledby={`${control.key}-language`}
              checked={checked}
              className="mt-[3px] shrink-0"
              onCheckedChange={(nextChecked) => onChange(nextChecked)}
            />
            <Prose as="span" id={`${control.key}-language`}>{control.renderedLanguage}</Prose>
          </Surface>
        ))}
        <p className="m-0 text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--muted)]">
          Both choices are optional and start unchecked.
        </p>
        <Button className="mt-[var(--s-2)] w-fit" disabled={submitting} type="submit">
          {submitting ? "Submitting…" : "Submit choices"}
        </Button>
      </form>
      {result ? (
        <Notice aria-live="polite" className="mt-[var(--s-4)]" role="status" tone={result.tone}>
          {result.text}
        </Notice>
      ) : null}
      {conversationReady && consentToken ? (
        <Button
          className="mt-[var(--s-4)] w-fit"
          render={<Link href={`/consumer?tenant=${encodeURIComponent(tenantSlug)}&consent=${encodeURIComponent(consentToken)}`} />}
        >
          Start conversation
        </Button>
      ) : null}
      <nav aria-label="Legal pages" className="mt-[var(--s-6)] flex gap-[var(--s-5)] text-[length:var(--coach-body)]">
        <Link className={DOC_LINK_CLASS} href={`${base}/terms`}>Terms</Link>
        <Link className={DOC_LINK_CLASS} href={`${base}/privacy`}>Privacy</Link>
      </nav>
      <TechnicalDetail className="mt-[var(--s-6)]" items={technicalItems} />
    </DocumentShell>
  );
}

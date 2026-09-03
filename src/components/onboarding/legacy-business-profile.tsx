"use client";

import { FormEvent, useEffect, useState } from "react";

import {
  FieldShell,
  KitButton,
  KitInput,
  Prose,
  SelectCaret,
  Surface,
} from "@/components/kit/atomics";
import { OnboardingStage } from "@/components/onboarding/onboarding-stage";
import {
  COACH_EYEBROW_CLASS,
  COACH_FOOTNOTE_CLASS,
  COACH_READING_CLASS,
} from "@/components/workspace/live/coach-type";
import { CARRIER_TYPICAL_DAYS } from "@/lib/onboarding/contracts";
import { cn } from "@/lib/utils";

type Profile = {
  legalName: string; entityType: string; hasEin: boolean; websiteUrl: string; addressLine1: string;
  addressLine2: string | null; city: string; region: string; postalCode: string; countryCode: string;
};

const EMPTY: Profile = {
  legalName: "", entityType: "sole_proprietor", hasEin: false, websiteUrl: "", addressLine1: "",
  addressLine2: "", city: "", region: "", postalCode: "", countryCode: "US",
};

const ENTITY_TYPES = [
  { value: "sole_proprietor", label: "Sole proprietor" },
  { value: "llc", label: "LLC" },
  { value: "corporation", label: "Corporation" },
  { value: "partnership", label: "Partnership" },
  { value: "other", label: "Other" },
] as const;

const LABEL_CLASS = "block text-[16px] leading-[1.4] font-[500] text-[color:var(--body)]";

function Field({
  children,
  hint,
  id,
  label,
}: {
  children: React.ReactNode;
  hint?: string;
  id: string;
  label: string;
}) {
  return (
    <div className="min-w-0">
      <label className={LABEL_CLASS} htmlFor={id}>{label}</label>
      <div className="mt-[var(--s-2)]">{children}</div>
      {hint ? (
        <Prose className={`mt-[var(--s-2)] ${COACH_FOOTNOTE_CLASS}`} measure="caption">
          {hint}
        </Prose>
      ) : null}
    </div>
  );
}

/**
 * The native select, wearing the kit's field face.
 *
 * `SelectShell` in the atomics is a button with no menu behind it: it states a chosen value on a
 * settings row where the choice opens elsewhere. This is a form the coach fills in and submits, so
 * the control has to be a real `<select>` that a keyboard and a screen reader already understand.
 * It borrows `FieldShell`, so the focus treatment and the invalid state stay the kit's rather than
 * this file's.
 */
function NativeSelect({
  children,
  id,
  onChange,
  value,
}: {
  children: React.ReactNode;
  id: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <FieldShell className="relative h-[var(--coach-target)] w-full">
      <select
        className="min-w-0 flex-1 appearance-none bg-transparent text-[16px] text-[color:var(--ink)]"
        id={id}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {children}
      </select>
      <SelectCaret />
    </FieldShell>
  );
}

/** Named once so the error, the checkbox that clears it and the submit it blocks cannot drift. */
const EIN_ERROR_ID = "business-profile-ein-error";

export function LegacyBusinessProfile() {
  const [profile, setProfile] = useState<Profile>(EMPTY);
  const [status, setStatus] = useState("Loading saved business profile…");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch("/api/onboarding/business-profile", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json() as { profile?: Profile | null };
      if (!response.ok) throw new Error();
      if (payload.profile) setProfile({ ...payload.profile, addressLine2: payload.profile.addressLine2 ?? "" });
      setStatus(payload.profile ? "Saved business profile loaded." : "Enter the legal business details used for A2P filing.");
    }).catch(() => setStatus("Your saved business profile could not be loaded."));
  }, []);

  function change(key: keyof Profile, value: string | boolean) {
    setProfile((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setStatus("Saving your business profile…");
    try {
      const response = await fetch("/api/onboarding/business-profile", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(profile),
      });
      const payload = await response.json() as { profile?: Profile; audit?: { id: string } };
      if (!response.ok || !payload.profile || !payload.audit?.id) throw new Error();
      setProfile({ ...payload.profile, addressLine2: payload.profile.addressLine2 ?? "" });
      setStatus("Business profile saved. Logged in your onboarding audit trail.");
    } catch {
      setStatus("Business profile could not be saved. Check the required fields and try again.");
    } finally {
      setSaving(false);
    }
  }

  const requiresEin = profile.entityType === "llc" || profile.entityType === "corporation";
  const blockedByEin = requiresEin && !profile.hasEin;

  return (
    <OnboardingStage
      lead="These legal details are what the phone carriers check before they let your business send texts. We record whether you have an EIN, never the EIN itself."
      title="Your business details"
      width="narrow"
    >
      <div className="flex flex-col gap-[var(--s-5)]">

        {/*
          * A strip, not a card: this states what SetterFi already knows about the filing, and
          * nothing on it is the coach's to act on. It is here because a form asking for a legal
          * entity type with no explanation of what it feeds reads as bureaucracy; saying the wait
          * up front is the honest version, and it is the same range the journey's day counter
          * renders rather than a second number that could drift from it.
          */}
        <div className="surface-strip">
          <p className={COACH_EYEBROW_CLASS}>What this feeds</p>
          <Prose className={`mt-[var(--s-2)] ${COACH_READING_CLASS} text-[color:var(--muted)]`}>
            Saving this does not file anything with a carrier. Once SetterFi files, carrier vetting
            typically runs {CARRIER_TYPICAL_DAYS[0]} to {CARRIER_TYPICAL_DAYS[1]} days and the
            carriers publish no decision schedule, so your setup page counts real days rather than
            predicting a date.
          </Prose>
        </div>

        <Surface className="flex flex-col gap-[var(--s-5)]">
          <p
            aria-live="polite"
            className={`surface-well m-0 ${COACH_READING_CLASS} text-[color:var(--body)]`}
          >
            {status}
          </p>

          <form className="grid gap-[var(--s-4)]" onSubmit={(event) => void submit(event)}>
            <Field id="legal-name" label="Legal business name">
              <KitInput
                id="legal-name"
                onChange={(event) => change("legalName", event.target.value)}
                required
                shellClassName="w-full"
                value={profile.legalName}
              />
            </Field>

            <Field id="entity-type" label="Entity type">
              <NativeSelect
                id="entity-type"
                onChange={(value) => change("entityType", value)}
                value={profile.entityType}
              >
                {ENTITY_TYPES.map((entity) => (
                  <option key={entity.value} value={entity.value}>{entity.label}</option>
                ))}
              </NativeSelect>
            </Field>

            <label className="flex min-h-[var(--coach-target)] items-center gap-[var(--s-3)] text-[16px] leading-[1.5] text-[color:var(--body)]">
              <input
                checked={profile.hasEin}
                /* The 44px floor belongs to the label, which is the whole target; a 44px-tall
                   checkbox would sit off the baseline of the sentence beside it. */
                aria-describedby={blockedByEin ? EIN_ERROR_ID : undefined}
                className="size-[20px] shrink-0 accent-[var(--accent)]"
                data-coach-target="exempt"
                onChange={(event) => change("hasEin", event.target.checked)}
                type="checkbox"
              />
              This business has an EIN
            </label>

            {blockedByEin ? (
              /*
                Clay text, not `--negative`: that token is the disqualifier dash and fails AA as
                prose. This is an inline error, which `LEDGER.md` rules takes a text token and
                never becomes a `Status`.

                `role="alert"` because this appears in response to the entity-type selection rather
                than being present at load, and the reader who needs it may be nowhere near it on
                the page. It is named by both controls it governs -- the checkbox that clears it and
                the submit it disables -- because a submit that goes dead with an unannounced reason
                is a dead end for anyone who is not looking at the red sentence above it.
              */
              <Prose
                className={`${COACH_READING_CLASS} text-[color:var(--failure-text)]`}
                id={EIN_ERROR_ID}
                role="alert"
              >
                LLCs and corporations must have an EIN before this profile can be saved.
              </Prose>
            ) : null}

            <Field id="website-url" label="Website URL">
              <KitInput
                id="website-url"
                onChange={(event) => change("websiteUrl", event.target.value)}
                placeholder="https://example.com"
                required
                shellClassName="w-full"
                type="url"
                value={profile.websiteUrl}
              />
            </Field>

            <Field id="address-1" label="Address line 1">
              <KitInput
                id="address-1"
                onChange={(event) => change("addressLine1", event.target.value)}
                required
                shellClassName="w-full"
                value={profile.addressLine1}
              />
            </Field>

            <Field id="address-2" label="Address line 2 (optional)">
              <KitInput
                id="address-2"
                onChange={(event) => change("addressLine2", event.target.value)}
                shellClassName="w-full"
                value={profile.addressLine2 ?? ""}
              />
            </Field>

            <div className="grid gap-[var(--s-4)] sm:grid-cols-3">
              <Field id="city" label="City">
                <KitInput
                  id="city"
                  onChange={(event) => change("city", event.target.value)}
                  required
                  shellClassName="w-full"
                  value={profile.city}
                />
              </Field>
              <Field id="region" label="State / region">
                <KitInput
                  id="region"
                  onChange={(event) => change("region", event.target.value)}
                  required
                  shellClassName="w-full"
                  value={profile.region}
                />
              </Field>
              <Field id="postal-code" label="Postal code">
                <KitInput
                  className="mono tabular-nums"
                  id="postal-code"
                  onChange={(event) => change("postalCode", event.target.value)}
                  required
                  shellClassName="w-full"
                  value={profile.postalCode}
                />
              </Field>
            </div>

            <Field id="country-code" label="Country code">
              <KitInput
                className="mono tabular-nums"
                id="country-code"
                maxLength={2}
                onChange={(event) => change("countryCode", event.target.value.toUpperCase())}
                required
                shellClassName="w-[110px]"
                value={profile.countryCode}
              />
            </Field>

            <div className={cn("flex flex-wrap items-center gap-[var(--s-3)] border-t border-[var(--line-soft)] pt-[var(--s-4)]")}>
              <KitButton
                className="h-[var(--coach-target-primary)] px-[28px] text-[18px]"
                aria-describedby={blockedByEin ? EIN_ERROR_ID : undefined}
                disabled={saving || blockedByEin}
                size="lg"
                type="submit"
                variant="primary"
              >
                {saving ? "Saving…" : "Save business profile"}
              </KitButton>
              <span className={COACH_FOOTNOTE_CLASS}>
                Saving is logged in your onboarding audit trail.
              </span>
            </div>
          </form>
        </Surface>
      </div>
    </OnboardingStage>
  );
}

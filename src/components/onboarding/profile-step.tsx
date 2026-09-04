"use client";

/*
 * Step 1 of 6, drawn from `OnboardingStep.dc.html`.
 *
 * The data is unchanged: the same `GET/POST /api/onboarding/business-profile`, the same ten
 * fields, the same EIN rule blocking the submit, the same read-back after the save.
 *
 * **The board draws four fields and this draws ten, on purpose.** The drawing is an illustration
 * of the step's shape, and the ten fields are what the phone carriers actually check before they
 * let a business send texts. Cutting six of them to match a picture would make the step pass while
 * filing an application the carriers reject, which is the release boundary in `README.md` broken
 * in the one place it costs a coach three weeks.
 *
 * What did change is the chrome and the words. There is no header band above the panel, because
 * the h1 already names the step; the two paragraphs about carrier vetting are the eye's; and the
 * footer is one filled Continue with one plain way out, which becomes a sticky full-width bar at
 * 390px.
 */

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

import { KitInput } from "@/components/kit/atomics";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  OnboardingStepShell,
  STEP_FIELD_CLASS,
  STEP_MONO_CLASS,
  STEP_PANEL_CLASS,
  STEP_PRIMARY_CLASS,
  StepField,
  nextStepHref,
} from "@/components/onboarding/step-shell";
import { CARRIER_TYPICAL_DAYS } from "@/lib/onboarding/contracts";

type Profile = {
  legalName: string;
  entityType: string;
  hasEin: boolean;
  websiteUrl: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
};

const EMPTY: Profile = {
  legalName: "",
  entityType: "sole_proprietor",
  hasEin: false,
  websiteUrl: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  region: "",
  postalCode: "",
  countryCode: "US",
};

const ENTITY_TYPES = [
  { value: "sole_proprietor", label: "Sole proprietor" },
  { value: "llc", label: "LLC" },
  { value: "corporation", label: "Corporation" },
  { value: "partnership", label: "Partnership" },
  { value: "other", label: "Other" },
] as const;

/** The sentences this screen used to print as help text, handed to the eye instead. */
export const PROFILE_STEP_EYE_COPY =
  "These legal details are what the phone carriers check before they let your business send "
  + "texts, and your agent says your business name and what you do to your leads, so write them "
  + "the way you would say them. SetterFi records whether you have an EIN, never the EIN itself. "
  + "Saving this files nothing with a carrier: SetterFi sends it on at the texting step, and "
  + `carrier vetting then typically runs ${CARRIER_TYPICAL_DAYS[0]} to ${CARRIER_TYPICAL_DAYS[1]} `
  + "days. The carriers publish no decision schedule, so your setup page counts real days rather "
  + "than predicting a date. LLCs and corporations must have an EIN before the profile can be "
  + "saved.";

/** Named once so the error, the checkbox that clears it and the submit it blocks cannot drift. */
const EIN_ERROR_ID = "business-profile-ein-error";

export function ProfileStep() {
  const [profile, setProfile] = useState<Profile>(EMPTY);
  const [status, setStatus] = useState("Loading saved business profile…");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch("/api/onboarding/business-profile", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json() as { profile?: Profile | null };
      if (!response.ok) throw new Error();
      if (payload.profile) {
        setProfile({ ...payload.profile, addressLine2: payload.profile.addressLine2 ?? "" });
      }
      setStatus(payload.profile
        ? "Saved business profile loaded."
        : "Nothing is filed with a carrier yet.");
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
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(profile),
      });
      const payload = await response.json() as { profile?: Profile; audit?: { id: string } };
      if (!response.ok || !payload.profile || !payload.audit?.id) throw new Error();
      setProfile({ ...payload.profile, addressLine2: payload.profile.addressLine2 ?? "" });
      setSaved(true);
      setStatus("Business profile saved. Logged in your onboarding audit trail.");
    } catch {
      setSaved(false);
      setStatus("Business profile could not be saved. Check the required fields and try again.");
    } finally {
      setSaving(false);
    }
  }

  const requiresEin = profile.entityType === "llc" || profile.entityType === "corporation";
  const blockedByEin = requiresEin && !profile.hasEin;

  /*
   * One control, two states, and the second only exists once there is something to carry forward.
   * Before the save, Continue is the submit; after it, Continue is the link to the next step. A
   * screen that offered both at once would present two forward actions, and one of them would move
   * a coach past an unsaved form.
   */
  const primary = saved
    ? (
      <Link className={STEP_PRIMARY_CLASS} href={nextStepHref("business_profile")}>
        Continue to connecting
      </Link>
    )
    : (
      <button
        aria-describedby={blockedByEin ? EIN_ERROR_ID : undefined}
        className={STEP_PRIMARY_CLASS}
        disabled={saving || blockedByEin}
        form="business-profile-form"
        type="submit"
      >
        {saving ? "Saving…" : "Continue"}
      </button>
    );

  return (
    <OnboardingStepShell
      eyeCopy={PROFILE_STEP_EYE_COPY}
      eyeScreen="onboarding-profile"
      lead="Your agent says these words to your leads, so write them the way you would say them."
      primary={primary}
      stepKey="business_profile"
      width={860}
    >
      <form
        className={STEP_PANEL_CLASS}
        id="business-profile-form"
        onSubmit={(event) => void submit(event)}
      >
        <div className="flex flex-col gap-[20px] p-[22px_16px] sm:p-[24px_20px]">
          <p
            aria-live="polite"
            className="m-0 text-[16px] leading-[1.4] text-[color:var(--muted)]"
          >
            {status}
          </p>

          <StepField id="legal-name" label="Legal business name">
            <KitInput
              className="text-[16px]"
              id="legal-name"
              onChange={(event) => change("legalName", event.target.value)}
              required
              shellClassName={STEP_FIELD_CLASS}
              value={profile.legalName}
            />
          </StepField>

          <div className="grid gap-[20px] sm:grid-cols-2">
            <StepField id="entity-type" label="Entity type">
              <Select
                onValueChange={(value) => change("entityType", value ?? profile.entityType)}
                value={profile.entityType}
              >
                <SelectTrigger className={STEP_FIELD_CLASS} id="entity-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  {ENTITY_TYPES.map((entity) => (
                    <SelectItem key={entity.value} value={entity.value}>{entity.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </StepField>

            <label className="flex h-[48px] items-center gap-[12px] self-end text-[16px] leading-[1.5] text-[color:var(--body)]">
              <input
                aria-describedby={blockedByEin ? EIN_ERROR_ID : undefined}
                checked={profile.hasEin}
                /* The 44px floor belongs to the label, which is the whole target; a 44px-tall
                   checkbox would sit off the baseline of the sentence beside it. */
                className="size-[20px] shrink-0 accent-[var(--accent)]"
                data-coach-target="exempt"
                onChange={(event) => change("hasEin", event.target.checked)}
                type="checkbox"
              />
              This business has an EIN
            </label>
          </div>

          {blockedByEin ? (
            /*
              `role="alert"` because this appears in response to the entity-type selection rather
              than being present at load, and it is named by both controls it governs: the checkbox
              that clears it and the submit it disables.
            */
            <p
              className="m-0 text-[16px] leading-[1.4] text-[color:var(--failure-text)]"
              id={EIN_ERROR_ID}
              role="alert"
            >
              LLCs and corporations must have an EIN before this profile can be saved.
            </p>
          ) : null}

          <StepField id="website-url" label="Website URL">
            <KitInput
              className={`text-[16px] ${STEP_MONO_CLASS}`}
              id="website-url"
              onChange={(event) => change("websiteUrl", event.target.value)}
              placeholder="https://example.com"
              required
              shellClassName={STEP_FIELD_CLASS}
              type="url"
              value={profile.websiteUrl}
            />
          </StepField>

          <div className="grid gap-[20px] sm:grid-cols-2">
            <StepField id="address-1" label="Address line 1">
              <KitInput
                className="text-[16px]"
                id="address-1"
                onChange={(event) => change("addressLine1", event.target.value)}
                required
                shellClassName={STEP_FIELD_CLASS}
                value={profile.addressLine1}
              />
            </StepField>

            <StepField id="address-2" label="Address line 2 (optional)">
              <KitInput
                className="text-[16px]"
                id="address-2"
                onChange={(event) => change("addressLine2", event.target.value)}
                placeholder="Suite, floor, unit"
                shellClassName={STEP_FIELD_CLASS}
                value={profile.addressLine2 ?? ""}
              />
            </StepField>
          </div>

          <div className="grid gap-[20px] sm:grid-cols-2">
            <StepField id="city" label="City">
              <KitInput
                className="text-[16px]"
                id="city"
                onChange={(event) => change("city", event.target.value)}
                required
                shellClassName={STEP_FIELD_CLASS}
                value={profile.city}
              />
            </StepField>

            <StepField id="region" label="State / region">
              <KitInput
                className="text-[16px]"
                id="region"
                onChange={(event) => change("region", event.target.value)}
                required
                shellClassName={STEP_FIELD_CLASS}
                value={profile.region}
              />
            </StepField>

            <StepField id="postal-code" label="Postal code">
              <KitInput
                className={`text-[16px] ${STEP_MONO_CLASS}`}
                id="postal-code"
                onChange={(event) => change("postalCode", event.target.value)}
                required
                shellClassName={STEP_FIELD_CLASS}
                value={profile.postalCode}
              />
            </StepField>

            <StepField id="country-code" label="Country">
              <KitInput
                className={`text-[16px] ${STEP_MONO_CLASS}`}
                id="country-code"
                maxLength={2}
                onChange={(event) => change("countryCode", event.target.value.toUpperCase())}
                required
                shellClassName={STEP_FIELD_CLASS}
                value={profile.countryCode}
              />
            </StepField>
          </div>
        </div>
      </form>
    </OnboardingStepShell>
  );
}

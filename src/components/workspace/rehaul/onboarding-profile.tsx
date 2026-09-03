"use client";

/*
 * Step 1 of setup, drawn from `OnboardingProfile.body.html`.
 *
 * The data is the live page's, unchanged: the same `GET/POST /api/onboarding/business-profile`,
 * the same ten fields, the same EIN rule blocking the submit, the same read-back after the save.
 * Nothing here queries anything the old page did not.
 *
 * What changed is the words. The page used to open with two paragraphs about carrier vetting and
 * hang a hint under a field; those sentences are now the context eye's, and the panel carries a
 * heading, ten labelled controls and one action.
 */

import { useEffect, useState, type FormEvent } from "react";

import { KitButton, KitInput } from "@/components/kit/atomics";
import { DeckPanel } from "@/components/kit/deck-panel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShieldCheck } from "@/components/kit/icons";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import {
  ONBOARDING_FIELD_CLASS,
  ONBOARDING_MONO_CLASS,
  OnboardingField,
  OnboardingFooter,
  OnboardingShell,
} from "@/components/workspace/rehaul/onboarding-shell";
import { CARRIER_TYPICAL_DAYS } from "@/lib/onboarding/contracts";

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

/** The sentences this screen used to print as help text, handed to the eye instead. */
export const ONBOARDING_PROFILE_EYE_COPY =
  "These legal details are what the phone carriers check before they let your business send "
  + "texts. SetterFi records whether you have an EIN, never the EIN itself. Saving this files "
  + "nothing with a carrier: SetterFi sends it on at step 5, and carrier vetting then typically "
  + `runs ${CARRIER_TYPICAL_DAYS[0]} to ${CARRIER_TYPICAL_DAYS[1]} days. The carriers publish no `
  + "decision schedule, so your setup page counts real days rather than predicting a date. LLCs "
  + "and corporations must have an EIN before the profile can be saved.";

/** Named once so the error, the checkbox that clears it and the submit it blocks cannot drift. */
const EIN_ERROR_ID = "business-profile-ein-error";

export function OnboardingProfileRehaul() {
  const [profile, setProfile] = useState<Profile>(EMPTY);
  const [status, setStatus] = useState("Loading saved business profile…");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch("/api/onboarding/business-profile", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json() as { profile?: Profile | null };
      if (!response.ok) throw new Error();
      if (payload.profile) setProfile({ ...payload.profile, addressLine2: payload.profile.addressLine2 ?? "" });
      setStatus(payload.profile ? "Saved business profile loaded." : "Nothing is filed with a carrier yet.");
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

  return (
    <OnboardingShell
      status={[{
        /*
         * Amber on both arms. Saving is a real step forward, but the state it leaves behind is
         * still "nothing is filed with a carrier", which is a pending state and pending is amber.
         * Green here would be the screen's own save reading as a carrier's answer.
         */
        label: saved ? "Saved, and not yet filed with a carrier" : "Nothing is filed with a carrier yet",
        tone: "warning",
      }]}
      step={1}
      title="Your business details"
      width={1080}
    >
      <form className="flex flex-col gap-[24px]" onSubmit={(event) => void submit(event)}>
        <DeckPanel
          eyebrow="What the carriers check"
          headingId="onboarding-profile-legal"
          meta={<span className="text-[14px] text-[color:var(--muted)]">{profile.legalName || "Not named yet"}</span>}
          name="Legal details"
        >
          <p aria-live="polite" className="m-0 mb-[20px] text-[15px] leading-[1.4] text-[color:var(--muted)]">
            {status}
          </p>

          <div className="flex flex-col gap-[20px]">
            <div className="grid gap-[20px] @min-[720px]/onboarding:grid-cols-2">
              <OnboardingField id="legal-name" label="Legal business name">
                <KitInput
                  className="text-[16px]"
                  id="legal-name"
                  onChange={(event) => change("legalName", event.target.value)}
                  required
                  shellClassName={ONBOARDING_FIELD_CLASS}
                  value={profile.legalName}
                />
              </OnboardingField>

              <OnboardingField id="entity-type" label="Entity type">
                <Select
                  onValueChange={(value) => change("entityType", value ?? profile.entityType)}
                  value={profile.entityType}
                >
                  <SelectTrigger className={ONBOARDING_FIELD_CLASS} id="entity-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start" alignItemWithTrigger={false}>
                    {ENTITY_TYPES.map((entity) => (
                      <SelectItem key={entity.value} value={entity.value}>{entity.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </OnboardingField>
            </div>

            <div className="grid items-end gap-[20px] @min-[720px]/onboarding:grid-cols-2">
              <OnboardingField id="website-url" label="Website URL">
                <KitInput
                  className={`text-[16px] ${ONBOARDING_MONO_CLASS}`}
                  id="website-url"
                  onChange={(event) => change("websiteUrl", event.target.value)}
                  placeholder="https://example.com"
                  required
                  shellClassName={ONBOARDING_FIELD_CLASS}
                  type="url"
                  value={profile.websiteUrl}
                />
              </OnboardingField>

              <label className="flex h-[48px] items-center gap-[12px] text-[16px] leading-[1.5] text-[color:var(--body)]">
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
                than being present at load, and it is named by both controls it governs -- the
                checkbox that clears it and the submit it disables.
              */
              <p
                className="m-0 text-[15px] leading-[1.4] text-[color:var(--failure-text)]"
                id={EIN_ERROR_ID}
                role="alert"
              >
                LLCs and corporations must have an EIN before this profile can be saved.
              </p>
            ) : null}

            <div className="grid gap-[20px] @min-[720px]/onboarding:grid-cols-2">
              <OnboardingField id="address-1" label="Address line 1">
                <KitInput
                  className="text-[16px]"
                  id="address-1"
                  onChange={(event) => change("addressLine1", event.target.value)}
                  required
                  shellClassName={ONBOARDING_FIELD_CLASS}
                  value={profile.addressLine1}
                />
              </OnboardingField>

              <OnboardingField id="address-2" label="Address line 2 (optional)">
                <KitInput
                  className="text-[16px]"
                  id="address-2"
                  onChange={(event) => change("addressLine2", event.target.value)}
                  placeholder="Suite, floor, unit"
                  shellClassName={ONBOARDING_FIELD_CLASS}
                  value={profile.addressLine2 ?? ""}
                />
              </OnboardingField>
            </div>

            <div className="grid gap-[20px] @min-[720px]/onboarding:grid-cols-[1.4fr_1fr_0.9fr_0.7fr]">
              <OnboardingField id="city" label="City">
                <KitInput
                  className="text-[16px]"
                  id="city"
                  onChange={(event) => change("city", event.target.value)}
                  required
                  shellClassName={ONBOARDING_FIELD_CLASS}
                  value={profile.city}
                />
              </OnboardingField>

              <OnboardingField id="region" label="State / region">
                <KitInput
                  className="text-[16px]"
                  id="region"
                  onChange={(event) => change("region", event.target.value)}
                  required
                  shellClassName={ONBOARDING_FIELD_CLASS}
                  value={profile.region}
                />
              </OnboardingField>

              <OnboardingField id="postal-code" label="Postal code">
                <KitInput
                  className={`text-[16px] ${ONBOARDING_MONO_CLASS}`}
                  id="postal-code"
                  onChange={(event) => change("postalCode", event.target.value)}
                  required
                  shellClassName={ONBOARDING_FIELD_CLASS}
                  value={profile.postalCode}
                />
              </OnboardingField>

              <OnboardingField id="country-code" label="Country">
                <KitInput
                  className={`text-[16px] ${ONBOARDING_MONO_CLASS}`}
                  id="country-code"
                  maxLength={2}
                  onChange={(event) => change("countryCode", event.target.value.toUpperCase())}
                  required
                  shellClassName={ONBOARDING_FIELD_CLASS}
                  value={profile.countryCode}
                />
              </OnboardingField>
            </div>
          </div>
        </DeckPanel>

        <OnboardingFooter
          actions={
            <>
              <span className="inline-flex items-center gap-[8px] text-[14px] leading-[1.4] text-[color:var(--muted)]">
                <ShieldCheck aria-hidden className="size-[16px]" />
                Logged in your onboarding audit trail
              </span>
              <KitButton
                aria-describedby={blockedByEin ? EIN_ERROR_ID : undefined}
                className="h-[48px] px-[28px] text-[17px]"
                disabled={saving || blockedByEin}
                size="lg"
                type="submit"
                variant="primary"
              >
                {saving ? "Saving…" : "Continue"}
              </KitButton>
            </>
          }
          sentence="Saving this files nothing with a carrier; SetterFi sends it on in step 5."
        />
      </form>

      <ContextEye copy={ONBOARDING_PROFILE_EYE_COPY} screen="onboarding-profile" />
    </OnboardingShell>
  );
}

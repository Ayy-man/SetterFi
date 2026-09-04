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

import { useEffect, useRef, useState, type FormEvent } from "react";

import { KitButton, KitInput } from "@/components/kit/atomics";
import { DeckPanel } from "@/components/kit/deck-panel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OctagonAlert, ShieldCheck } from "@/components/kit/icons";
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

type ProfileKey = keyof Profile;

const PROFILE_KEYS: readonly ProfileKey[] = [
  "legalName", "entityType", "hasEin", "websiteUrl", "addressLine1", "addressLine2",
  "city", "region", "postalCode", "countryCode",
];

/**
 * Only the ten fields the API accepts. A loaded profile also carries its id and timestamp, and
 * sending those back is what used to make every re-save of a saved profile fail.
 */
function pick(source: Record<string, unknown>): Profile {
  const next: Record<string, unknown> = { ...EMPTY };
  for (const key of PROFILE_KEYS) if (key in source) next[key] = source[key];
  next.addressLine2 = typeof next.addressLine2 === "string" ? next.addressLine2 : "";
  return next as Profile;
}

/** What each field says under itself when it stops the save. */
const FIELD_LABEL: Record<ProfileKey, string> = {
  legalName: "Legal business name", entityType: "Entity type", hasEin: "EIN", websiteUrl: "Website URL",
  addressLine1: "Address line 1", addressLine2: "Address line 2", city: "City", region: "State / region",
  postalCode: "Postal code", countryCode: "Country",
};

const FIELD_ID: Record<ProfileKey, string> = {
  legalName: "legal-name", entityType: "entity-type", hasEin: "has-ein", websiteUrl: "website-url",
  addressLine1: "address-1", addressLine2: "address-2", city: "city", region: "region",
  postalCode: "postal-code", countryCode: "country-code",
};

function fieldProblem(key: ProfileKey, profile: Profile): string | null {
  const value = profile[key];
  const text = typeof value === "string" ? value.trim() : "";
  switch (key) {
    case "websiteUrl":
      if (!text) return "Required.";
      return /^https?:\/\/\S+\.\S+$/u.test(text) ? null : "A full web address, like https://example.com.";
    case "countryCode":
      if (!text) return "Required.";
      return /^[A-Za-z]{2}$/u.test(text) ? null : "The two-letter code, like US.";
    case "legalName": case "addressLine1": case "city": case "region": case "postalCode":
      return text ? null : "Required.";
    default:
      return null;
  }
}

/** The problems the form can see before asking the server. Same rules as the API's. */
function problems(profile: Profile): Partial<Record<ProfileKey, string>> {
  const found: Partial<Record<ProfileKey, string>> = {};
  for (const key of PROFILE_KEYS) {
    const problem = fieldProblem(key, profile);
    if (problem) found[key] = problem;
  }
  return found;
}

function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

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
  const [failure, setFailure] = useState<{ sentence: string; fields: Partial<Record<ProfileKey, string>> } | null>(null);
  /* Counts refusals so a field that was already red shakes again on the next one. */
  const [attempt, setAttempt] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    void fetch("/api/onboarding/business-profile", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json() as { profile?: Profile | null };
      if (!response.ok) throw new Error();
      if (payload.profile) setProfile(pick(payload.profile as unknown as Record<string, unknown>));
      setStatus(payload.profile ? "Saved business profile loaded." : "Nothing is filed with a carrier yet.");
    }).catch(() => setStatus("Your saved business profile could not be loaded."));
  }, []);

  function change(key: ProfileKey, value: string | boolean) {
    setProfile((current) => ({ ...current, [key]: value }));
    setFailure((current) => {
      if (!current?.fields[key]) return current;
      const fields = { ...current.fields };
      delete fields[key];
      return { ...current, fields };
    });
  }

  function refuse(fields: Partial<Record<ProfileKey, string>>, sentence?: string) {
    const names = PROFILE_KEYS.filter((key) => fields[key]).map((key) => FIELD_LABEL[key]);
    setSaved(false);
    setFailure({
      fields,
      sentence: sentence ?? (names.length === 1
        ? `${names[0]} needs a look before this can be saved.`
        : `${names.length} fields need a look before this can be saved: ${nameList(names)}.`),
    });
    setAttempt((count) => count + 1);
  }

  /* After the refusal has drawn: the red fields remount to restart their shake, so the focus has
     to land on the new element, not the one the submit handler could see. */
  useEffect(() => {
    if (attempt === 0 || !failure) return;
    const first = PROFILE_KEYS.find((key) => failure.fields[key]);
    const target = first
      ? formRef.current?.querySelector<HTMLElement>(`#${FIELD_ID[first]}`)
      : formRef.current?.querySelector<HTMLElement>('[data-slot="onboarding-refusal"]');
    if (target && !first) target.tabIndex = -1;
    target?.focus({ preventScroll: false });
    // Only the refusal count should re-run this; the fields clear as the coach types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const local = problems(profile);
    if (Object.keys(local).length > 0) {
      refuse(local);
      return;
    }
    setSaving(true);
    setFailure(null);
    setStatus("Saving your business profile…");
    try {
      const response = await fetch("/api/onboarding/business-profile", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pick(profile)),
      });
      const payload = await response.json().catch(() => ({})) as {
        profile?: Profile; audit?: { id: string }; error?: string; fields?: string[];
      };
      if (response.status === 400 && Array.isArray(payload.fields)) {
        const fields: Partial<Record<ProfileKey, string>> = {};
        for (const key of payload.fields) {
          if ((PROFILE_KEYS as readonly string[]).includes(key)) {
            fields[key as ProfileKey] = fieldProblem(key as ProfileKey, profile) ?? "Check this field.";
          }
        }
        refuse(fields, Object.keys(fields).length === 0 ? "The server refused this profile. Nothing changed." : undefined);
        setStatus("Nothing was saved.");
        return;
      }
      if (!response.ok || !payload.profile || !payload.audit?.id) {
        refuse({}, response.status === 403
          ? "This session cannot change the business profile. Nothing changed."
          : "The profile could not be saved just now. Nothing changed, so you can try again.");
        setStatus("Nothing was saved.");
        return;
      }
      setProfile(pick(payload.profile as unknown as Record<string, unknown>));
      setSaved(true);
      setStatus("Business profile saved. Logged in your onboarding audit trail.");
    } catch {
      refuse({}, "The profile could not be sent. Check your connection and try again; nothing changed.");
      setStatus("Nothing was saved.");
    } finally {
      setSaving(false);
    }
  }

  const invalid = (key: ProfileKey) => Boolean(failure?.fields[key]);
  const describedBy = (key: ProfileKey) => (failure?.fields[key] ? `${FIELD_ID[key]}-error` : undefined);

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
      <form className="flex flex-col gap-[24px]" noValidate onSubmit={(event) => void submit(event)} ref={formRef}>
        <DeckPanel
          eyebrow="What the carriers check"
          headingId="onboarding-profile-legal"
          meta={<span className="text-[14px] text-[color:var(--muted)]">{profile.legalName || "Not named yet"}</span>}
          name="Legal details"
        >
          {failure ? (
            /*
             * The refusal is a callout in the failure family, not the muted status line: it is the
             * one thing on the panel the coach has to act on, so it takes the panel's loudest face.
             */
            <div
              className="mb-[20px] flex items-start gap-[12px] rounded-[10px] border border-[var(--failure-line)] bg-[var(--failure-wash)] px-[16px] py-[14px] text-[16px] leading-[1.5] text-[color:var(--failure-text)]"
              data-slot="onboarding-refusal"
              key={attempt}
              role="alert"
            >
              <OctagonAlert aria-hidden className="mt-[3px] size-[18px] shrink-0" />
              <span>{failure.sentence}</span>
            </div>
          ) : (
            <p aria-live="polite" className="m-0 mb-[20px] text-[15px] leading-[1.4] text-[color:var(--muted)]">
              {status}
            </p>
          )}

          <div className="flex flex-col gap-[20px]">
            <div className="grid gap-[20px] @min-[720px]/onboarding:grid-cols-2">
              <OnboardingField error={failure?.fields.legalName} id="legal-name" key={`legal-name-${attempt}`} label="Legal business name">
                <KitInput
                  className="text-[16px]"
                  aria-describedby={describedBy("legalName")}
                  id="legal-name"
                  invalid={invalid("legalName")}
                  onChange={(event) => change("legalName", event.target.value)}
                  required
                  shellClassName={ONBOARDING_FIELD_CLASS}
                  value={profile.legalName}
                />
              </OnboardingField>

              <OnboardingField error={failure?.fields.entityType} id="entity-type" key={`entity-type-${attempt}`} label="Entity type">
                <Select
                  onValueChange={(value) => change("entityType", value ?? profile.entityType)}
                  value={profile.entityType}
                >
                  <SelectTrigger aria-invalid={invalid("entityType") || undefined} className={ONBOARDING_FIELD_CLASS} id="entity-type">
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
              <OnboardingField error={failure?.fields.websiteUrl} id="website-url" key={`website-url-${attempt}`} label="Website URL">
                <KitInput
                  className={`text-[16px] ${ONBOARDING_MONO_CLASS}`}
                  aria-describedby={describedBy("websiteUrl")}
                  id="website-url"
                  invalid={invalid("websiteUrl")}
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
              <OnboardingField error={failure?.fields.addressLine1} id="address-1" key={`address-1-${attempt}`} label="Address line 1">
                <KitInput
                  className="text-[16px]"
                  aria-describedby={describedBy("addressLine1")}
                  id="address-1"
                  invalid={invalid("addressLine1")}
                  onChange={(event) => change("addressLine1", event.target.value)}
                  required
                  shellClassName={ONBOARDING_FIELD_CLASS}
                  value={profile.addressLine1}
                />
              </OnboardingField>

              <OnboardingField error={failure?.fields.addressLine2} id="address-2" key={`address-2-${attempt}`} label="Address line 2 (optional)">
                <KitInput
                  className="text-[16px]"
                  aria-describedby={describedBy("addressLine2")}
                  id="address-2"
                  invalid={invalid("addressLine2")}
                  onChange={(event) => change("addressLine2", event.target.value)}
                  placeholder="Suite, floor, unit"
                  shellClassName={ONBOARDING_FIELD_CLASS}
                  value={profile.addressLine2 ?? ""}
                />
              </OnboardingField>
            </div>

            <div className="grid gap-[20px] @min-[720px]/onboarding:grid-cols-[1.4fr_1fr_0.9fr_0.7fr]">
              <OnboardingField error={failure?.fields.city} id="city" key={`city-${attempt}`} label="City">
                <KitInput
                  className="text-[16px]"
                  aria-describedby={describedBy("city")}
                  id="city"
                  invalid={invalid("city")}
                  onChange={(event) => change("city", event.target.value)}
                  required
                  shellClassName={ONBOARDING_FIELD_CLASS}
                  value={profile.city}
                />
              </OnboardingField>

              <OnboardingField error={failure?.fields.region} id="region" key={`region-${attempt}`} label="State / region">
                <KitInput
                  className="text-[16px]"
                  aria-describedby={describedBy("region")}
                  id="region"
                  invalid={invalid("region")}
                  onChange={(event) => change("region", event.target.value)}
                  required
                  shellClassName={ONBOARDING_FIELD_CLASS}
                  value={profile.region}
                />
              </OnboardingField>

              <OnboardingField error={failure?.fields.postalCode} id="postal-code" key={`postal-code-${attempt}`} label="Postal code">
                <KitInput
                  className={`text-[16px] ${ONBOARDING_MONO_CLASS}`}
                  aria-describedby={describedBy("postalCode")}
                  id="postal-code"
                  invalid={invalid("postalCode")}
                  onChange={(event) => change("postalCode", event.target.value)}
                  required
                  shellClassName={ONBOARDING_FIELD_CLASS}
                  value={profile.postalCode}
                />
              </OnboardingField>

              <OnboardingField error={failure?.fields.countryCode} id="country-code" key={`country-code-${attempt}`} label="Country">
                <KitInput
                  className={`text-[16px] ${ONBOARDING_MONO_CLASS}`}
                  aria-describedby={describedBy("countryCode")}
                  id="country-code"
                  invalid={invalid("countryCode")}
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

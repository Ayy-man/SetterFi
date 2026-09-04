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
import { useEffect, useRef, useState, type FormEvent } from "react";

import { KitInput } from "@/components/kit/atomics";
import { OctagonAlert } from "@/components/kit/icons";
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

/** What a field says under itself when it stops the save. Same rules as the API's. */
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

type Problems = Partial<Record<ProfileKey, string>>;

function problems(profile: Profile): Problems {
  const found: Problems = {};
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

export function ProfileStep() {
  const [profile, setProfile] = useState<Profile>(EMPTY);
  const [status, setStatus] = useState("Loading saved business profile…");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ sentence: string; fields: Problems } | null>(null);
  /* Counts refusals, so a field that was already red shakes again on the next one. */
  const [attempt, setAttempt] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    void fetch("/api/onboarding/business-profile", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json() as { profile?: Profile | null };
      if (!response.ok) throw new Error();
      if (payload.profile) setProfile(pick(payload.profile as unknown as Record<string, unknown>));
      setStatus(payload.profile
        ? "Saved business profile loaded."
        : "Nothing is filed with a carrier yet.");
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

  function refuse(fields: Problems, sentence?: string) {
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
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pick(profile)),
      });
      const payload = await response.json().catch(() => ({})) as {
        profile?: Profile; audit?: { id: string }; error?: string; fields?: string[];
      };
      if (response.status === 400 && Array.isArray(payload.fields)) {
        const fields: Problems = {};
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
        noValidate
        onSubmit={(event) => void submit(event)}
        ref={formRef}
      >
        <div className="flex flex-col gap-[20px] p-[22px_16px] sm:p-[24px_20px]">
          {failure ? (
            /*
             * The refusal is a callout in the failure family, not the muted status line: it is the
             * one thing on the panel the coach has to act on, so it takes the panel's loudest face.
             */
            <div
              className="flex items-start gap-[12px] rounded-[10px] border border-[var(--failure-line)] bg-[var(--failure-wash)] px-[16px] py-[14px] text-[16px] leading-[1.5] text-[color:var(--failure-text)]"
              data-slot="onboarding-refusal"
              key={attempt}
              role="alert"
            >
              <OctagonAlert aria-hidden className="mt-[3px] size-[18px] shrink-0" />
              <span>{failure.sentence}</span>
            </div>
          ) : (
            <p
              aria-live="polite"
              className="m-0 text-[16px] leading-[1.4] text-[color:var(--muted)]"
            >
              {status}
            </p>
          )}

          <StepField error={failure?.fields.legalName} id="legal-name" key={`legal-name-${attempt}`} label="Legal business name">
            <KitInput
              className="text-[16px]"
              aria-describedby={describedBy("legalName")}
              id="legal-name"
              invalid={invalid("legalName")}
              onChange={(event) => change("legalName", event.target.value)}
              required
              shellClassName={STEP_FIELD_CLASS}
              value={profile.legalName}
            />
          </StepField>

          <div className="grid gap-[20px] sm:grid-cols-2">
            <StepField error={failure?.fields.entityType} id="entity-type" key={`entity-type-${attempt}`} label="Entity type">
              <Select
                onValueChange={(value) => change("entityType", value ?? profile.entityType)}
                value={profile.entityType}
              >
                <SelectTrigger aria-invalid={invalid("entityType") || undefined} className={STEP_FIELD_CLASS} id="entity-type">
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

          <StepField error={failure?.fields.websiteUrl} id="website-url" key={`website-url-${attempt}`} label="Website URL">
            <KitInput
              className={`text-[16px] ${STEP_MONO_CLASS}`}
              aria-describedby={describedBy("websiteUrl")}
              id="website-url"
              invalid={invalid("websiteUrl")}
              onChange={(event) => change("websiteUrl", event.target.value)}
              placeholder="https://example.com"
              required
              shellClassName={STEP_FIELD_CLASS}
              type="url"
              value={profile.websiteUrl}
            />
          </StepField>

          <div className="grid gap-[20px] sm:grid-cols-2">
            <StepField error={failure?.fields.addressLine1} id="address-1" key={`address-1-${attempt}`} label="Address line 1">
              <KitInput
                className="text-[16px]"
                aria-describedby={describedBy("addressLine1")}
                id="address-1"
                invalid={invalid("addressLine1")}
                onChange={(event) => change("addressLine1", event.target.value)}
                required
                shellClassName={STEP_FIELD_CLASS}
                value={profile.addressLine1}
              />
            </StepField>

            <StepField error={failure?.fields.addressLine2} id="address-2" key={`address-2-${attempt}`} label="Address line 2 (optional)">
              <KitInput
                className="text-[16px]"
                aria-describedby={describedBy("addressLine2")}
                id="address-2"
                invalid={invalid("addressLine2")}
                onChange={(event) => change("addressLine2", event.target.value)}
                placeholder="Suite, floor, unit"
                shellClassName={STEP_FIELD_CLASS}
                value={profile.addressLine2 ?? ""}
              />
            </StepField>
          </div>

          <div className="grid gap-[20px] sm:grid-cols-2">
            <StepField error={failure?.fields.city} id="city" key={`city-${attempt}`} label="City">
              <KitInput
                className="text-[16px]"
                aria-describedby={describedBy("city")}
                id="city"
                invalid={invalid("city")}
                onChange={(event) => change("city", event.target.value)}
                required
                shellClassName={STEP_FIELD_CLASS}
                value={profile.city}
              />
            </StepField>

            <StepField error={failure?.fields.region} id="region" key={`region-${attempt}`} label="State / region">
              <KitInput
                className="text-[16px]"
                aria-describedby={describedBy("region")}
                id="region"
                invalid={invalid("region")}
                onChange={(event) => change("region", event.target.value)}
                required
                shellClassName={STEP_FIELD_CLASS}
                value={profile.region}
              />
            </StepField>

            <StepField error={failure?.fields.postalCode} id="postal-code" key={`postal-code-${attempt}`} label="Postal code">
              <KitInput
                className={`text-[16px] ${STEP_MONO_CLASS}`}
                aria-describedby={describedBy("postalCode")}
                id="postal-code"
                invalid={invalid("postalCode")}
                onChange={(event) => change("postalCode", event.target.value)}
                required
                shellClassName={STEP_FIELD_CLASS}
                value={profile.postalCode}
              />
            </StepField>

            <StepField error={failure?.fields.countryCode} id="country-code" key={`country-code-${attempt}`} label="Country">
              <KitInput
                className={`text-[16px] ${STEP_MONO_CLASS}`}
                aria-describedby={describedBy("countryCode")}
                id="country-code"
                invalid={invalid("countryCode")}
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

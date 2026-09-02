"use client";

import type { ReactNode } from "react";

import { Chip } from "@/components/kit/atomics";

import { EditorAdvice, EditorRegion, SampleExchange } from "./offer-editor-chrome";

/**
 * Screen 3h, inline: how it sounds, with the sample rewriting as the coach types.
 *
 * The artifact's promise is that a coach hears the voice before their leads do, and the sample
 * keeps it: it regenerates on every keystroke. What it regenerates from is the coach's own saved
 * sentence, never a composed agent reply. The runtime writes replies through a gated pipeline, so
 * a handwritten sample would be showing wording no lead will ever receive -- the thing the coach
 * came here to check would be the one thing on the screen that was invented.
 *
 * The two sliders the artifact drew are one track here, because one register is what is stored.
 */

export type VoiceRegister = "professional" | "neutral" | "friendly";

export const VOICE_REGISTERS: readonly {
  detail: string;
  label: string;
  value: VoiceRegister;
}[] = [
  { value: "professional", label: "Professional", detail: "Reads like a business, not a friend." },
  { value: "neutral", label: "Balanced", detail: "Warm enough to answer, plain enough to trust." },
  { value: "friendly", label: "Friendly", detail: "A little warmth, no jokes about money." },
];

const VOICE_PROMPT = "How should a reply to a lead sound?";

export function registerIndex(brandVoice: string | null) {
  const found = VOICE_REGISTERS.findIndex((entry) => entry.value === brandVoice);
  return found < 0 ? 1 : found;
}

export type VoicePanelProps = {
  brandVoice: string | null;
  /** The page's own written answers: style, objections, follow-up. */
  children: ReactNode;
  onBrandVoiceChange: (next: VoiceRegister) => void;
  /** How many of the three answers the coach has written. Drives the sample's "because" line. */
  writtenCount: number;
  /** The saved style answer, which is what the sample reads back. */
  styleAnswer: string | null;
};

export function VoicePanel({
  brandVoice,
  children,
  onBrandVoiceChange,
  styleAnswer,
  writtenCount,
}: VoicePanelProps) {
  const index = registerIndex(brandVoice);
  const register = VOICE_REGISTERS[index];
  const style = styleAnswer?.trim() ?? "";

  return (
    <div className="@container/voice flex min-w-0 flex-col gap-[var(--s-4)]">
      <EditorRegion label="Register">
        {/*
          One track, three stops. The artifact's Direct/Gentle and Serious/Playful pair would need
          two stored dimensions; `brandVoice` is one enum with three members, so the control is
          drawn at the resolution the store actually has rather than at the mockup's.
        */}
        <div className="mb-[8px] flex items-baseline justify-between">
          <span className="text-[length:var(--coach-body)] leading-none font-semibold text-[color:var(--ink)]">
            Direct
          </span>
          <span className="text-[length:var(--coach-body)] leading-none text-[color:var(--muted)]">Warm</span>
        </div>
        <input
          aria-label="Brand voice"
          aria-valuetext={register.label}
          className="h-[8px] w-full cursor-pointer appearance-none rounded-full bg-[rgba(255,255,255,0.08)] accent-[var(--accent-bright)]"
          max={VOICE_REGISTERS.length - 1}
          min={0}
          onChange={(event) => {
            const next = VOICE_REGISTERS[Number(event.target.value)];
            if (next) onBrandVoiceChange(next.value);
          }}
          step={1}
          type="range"
          value={index}
        />
        <p className="mt-[10px] max-w-[var(--measure-prose)] text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--muted)]">
          <span className="text-[color:var(--accent-text)]">{register.label}</span>
          {": "}
          {register.detail}
        </p>
        <div className="mt-[14px] flex flex-wrap gap-[10px]">
          {VOICE_REGISTERS.map((entry) => (
            <Chip key={entry.value} selected={entry.value === register.value}>
              {entry.label}
            </Chip>
          ))}
        </div>
      </EditorRegion>

      {children}

      <SampleExchange
        because={[register.label.toLowerCase(), `${writtenCount} of 3 answers`]}
        caption="Your own words, read back as a lead will meet them. Your setter composes each real reply through the grounding and compliance gates, so nothing here is a script it will recite."
        label="Live sample"
        lead={VOICE_PROMPT}
        replies={[
          style ||
            "Not written yet. Your setter keeps our standard voice for funding offers until you answer this.",
        ]}
      />

      {register.value === "friendly" ? (
        <EditorAdvice>
          A friendly register tends to lower booking rates for offers over $3k. It is yours to
          choose. We would keep it one stop back.
        </EditorAdvice>
      ) : null}
    </div>
  );
}

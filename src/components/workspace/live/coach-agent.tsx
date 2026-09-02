import { DURABLE_TOUCHES, WINDOW_BOUND_TOUCHES } from "@/lib/followups/touch-lists";
import { OFFER_CADENCE_PURPOSE_LABELS } from "@/lib/offer/types";
import type { OfferCadenceChannel, OfferCadencePurpose } from "@/lib/offer/types";
import type { ChannelCapability } from "@/lib/sends/channel-capabilities";
import { resolvedCoachCadenceClass } from "./view-models";

export type CoachCadenceChannel = {
  channel: "sms" | "instagram" | "messenger" | "whatsapp";
  channelLabel: string;
  capability: ChannelCapability;
};

/** The two cadence classes a coach can attach purposes to. "none" carries no schedule. */
export type CoachCadenceScheduleClass = "durable" | "window_bound";

export type CoachCadenceScheduleTouch = {
  touchNo: number;
  /** Platform-owned timing, read-only for the coach. */
  when: string;
  defaultPurpose: OfferCadencePurpose;
};

export type CoachCadenceScheduleGroup = {
  channelClass: CoachCadenceScheduleClass;
  /** Connected channel names, or the class name when nothing is connected. */
  channelLabel: string;
  channelNote: string;
  connected: boolean;
  humanOnlyAfterWindow: boolean;
  touches: readonly CoachCadenceScheduleTouch[];
};

const SCHEDULE_ORDER: readonly CoachCadenceScheduleClass[] = [
  "window_bound",
  "durable",
];

function timingLabel(milliseconds: number) {
  const hours = milliseconds / (60 * 60 * 1_000);
  if (hours < 24) return `${hours} hours`;
  const days = hours / 24;
  return `${days} day${days === 1 ? "" : "s"}`;
}

function touchesFor(
  channelClass: CoachCadenceScheduleClass,
): CoachCadenceScheduleTouch[] {
  if (channelClass === "durable") {
    return DURABLE_TOUCHES.map((touch) => ({
      touchNo: touch.touchNo,
      when: `${timingLabel(touch.offsetMs)} after the lead goes quiet`,
      defaultPurpose: touch.purpose,
    }));
  }
  return WINDOW_BOUND_TOUCHES.map((touch) => ({
    touchNo: touch.touchNo,
    when: `${timingLabel(touch.beforeWindowCloseMs)} before the reply window closes`,
    defaultPurpose: touch.purpose,
  }));
}

/**
 * One follow-up schedule the coach reads top to bottom: the platform owns the channel class,
 * the touch count, and the timing, so only the purpose column is editable downstream. Channels
 * that resolve to the same class share one row group because a saved purpose is keyed by class
 * and touch number, never by channel.
 */
export function coachCadenceSchedule(
  channels: readonly CoachCadenceChannel[],
): CoachCadenceScheduleGroup[] {
  return SCHEDULE_ORDER.map((channelClass) => {
    const matched = channels.filter(
      (entry) =>
        resolvedCoachCadenceClass(entry.channel, entry.capability) === channelClass,
    );
    const touches = touchesFor(channelClass);
    const countNote =
      channelClass === "durable"
        ? `${touches.length} touches over two weeks`
        : `${touches.length} touches inside the reply window`;
    return {
      channelClass,
      channelLabel: matched.length
        ? matched.map((entry) => entry.channelLabel).join(", ")
        : channelClass === "durable"
          ? "Durable channels"
          : "Reply-window channels",
      channelNote: matched.length
        ? countNote
        : `${countNote}, no channel connected yet`,
      connected: matched.length > 0,
      humanOnlyAfterWindow: matched.some(
        (entry) => entry.capability.postWindow === "human_agent_only",
      ),
      touches,
    };
  });
}

/**
 * One exported row per rendered touch. The follow-up schedule is drawn as stacked rows rather
 * than a DataTable, so its export is built from the same schedule and saved purposes the section
 * renders instead of from a server resource: every table on a surface exports, and a hand-rolled
 * one has to carry the rows itself.
 */
export type CoachCadenceExportRow = {
  channelClass: CoachCadenceScheduleClass;
  channel: string;
  connected: boolean;
  touchNo: number;
  when: string;
  purpose: OfferCadencePurpose;
  purposeLabel: string;
  /** Which side chose it, the same claim the rendered row makes under the select. */
  purposeSource: "coach" | "platform";
};

export function coachCadenceExportRows(
  schedule: readonly CoachCadenceScheduleGroup[],
  /*
   * A saved purpose row may carry the "none" class, which no group schedules, so the input is
   * typed by the stored enum and those rows simply never match a rendered touch.
   */
  purposes: readonly {
    channelClass: OfferCadenceChannel;
    touchNo: number;
    purpose: OfferCadencePurpose;
  }[],
): CoachCadenceExportRow[] {
  return schedule.flatMap((group) =>
    group.touches.map((touch) => {
      const saved = purposes.find(
        (row) =>
          row.channelClass === group.channelClass && row.touchNo === touch.touchNo,
      )?.purpose;
      const purpose = saved ?? touch.defaultPurpose;
      return {
        channelClass: group.channelClass,
        channel: group.channelLabel,
        connected: group.connected,
        touchNo: touch.touchNo,
        when: touch.when,
        purpose,
        purposeLabel: OFFER_CADENCE_PURPOSE_LABELS[purpose],
        purposeSource: saved ? ("coach" as const) : ("platform" as const),
      };
    }),
  );
}

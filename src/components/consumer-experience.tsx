"use client";

import { CalendarDays, ChatIcon, Check, Lock, Refresh, ShieldCheck, UserRound } from "@/components/kit/icons";

import {
  Fragment,
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { initialsFor } from "@/components/kit/atomics/icon-tile";
import { Composer } from "@/components/kit/composer";

export type ConsumerMessage = {
  id: string;
  author: "agent" | "lead" | "human" | "system";
  authorName?: string;
  text: string;
  detail?: string;
  /**
   * When the turn was sent, already formatted for reading, and absent when there is no such time.
   *
   * It is optional because one turn genuinely has none: the opening greeting is composed on this
   * client the moment the screen mounts, it is never appended to the transcript, and no server ever
   * stamps it. It used to carry the literal `"10:04 AM"`, so every live lead met a first turn dated
   * from a mockup. A turn with no send time prints no time; it does not print a plausible one.
   */
  at?: string;
};

type ConsumerState =
  | "active"
  | "booked"
  | "nurture"
  | "closed"
  | "handoff"
  | "opted_out";

type ConsumerBooking = {
  id?: string;
  slot: string;
  label: string;
};

type TurnAuthor = { role: "assistant" | "system" | "human"; name?: string };

type ConsumerTurn = {
  reply: string;
  state: ConsumerState;
  booking: ConsumerBooking | null;
  author?: TurnAuthor;
};

export type ConsumerExperienceProps = {
  bookingConfirmEnabled?: boolean;
  businessName?: string;
  channel?: "sms" | "web";
  humanReplyWindow?: HumanReplyWindow | null;
  initialMessages?: readonly ConsumerMessage[];
  /**
   * The coach's own published programme name, off the offer layer.
   *
   * It is the only stored fact this surface can put behind the artboard's "What the call is about"
   * panel. The artboard fills that panel with a sentence naming the coach, the lead's funding
   * figure, a thirty-minute length and who dials whom, and the schema holds none of those: there
   * is no call-description or agenda column anywhere, no coach-editable call length on the offer
   * contract, and no direction, location or dial-in on `appointments`. Writing that sentence in
   * the component would be the agent making claims about a call the coach never described --
   * the same refusal the tone samples got.
   *
   * `program_name` is real and already crosses the wire: `start_consumer_conversation_session`
   * returns it and `startConsumerSession` reads it into `brand.programName`. The RPC coalesces an
   * unset offer to an empty string, so blank means "not published" and the panel does not render
   * at all rather than heading an empty card.
   */
  programName?: string | null;
  /**
   * The coach's own published privacy policy, which lives at `/opt-in/<tenantSlug>/privacy`.
   *
   * It is a prop and it defaults to absent because this surface has no tenant. The disclosure
   * used to link a bare `/privacy`, and no such route exists in `src/app` -- so the one link on
   * the most externally visible page in the product was a 404. A missing link is honest; a link
   * to nothing on a page about how a business handles your messages is not.
   */
  privacyHref?: string | null;
  sessionReference?: string | null;
};

export type HumanReplyWindow = {
  closesAt: string;
  opensAt: string;
  replyWithinHours: number;
  timeZoneLabel: string;
};

const BUSINESS_NAME = "Reid Funding Group";
/*
 * The last-resort zone for an *appointment* whose own zone cannot be read, and nothing else.
 *
 * It is not the clock chat timestamps are drawn on -- those are the lead's own, see `messageTime`.
 * It survives here because an appointment does carry an asserted zone (`resolveTimeZone` takes it
 * off the booking) and something has to happen when that value is a phrase `Intl` cannot use. Both
 * readers that fall back to it print the zone name beside the time, so a fallback is labelled
 * rather than passed off as the reader's own.
 */
const COACH_TIME_ZONE = "America/Chicago";

/**
 * The lead is talking to the business, and to a business the product can actually name.
 *
 * This surface used to open on a person -- "Marcus Whitfield · funding coach" in the header, his
 * initials on every assistant turn, his first name in the disclosure, in the booking panel and in
 * the reply-hours line. No such fact exists: `start_consumer_conversation_session` returns the
 * tenant's `name`, the published `program_name` and the opt-in artifact's `privacy_url`, and
 * there is no coach person-name, agent display-name or persona column anywhere in the schema for
 * it to return. So a lead of "Northgate Funding" met a person who does not work there, above a
 * monogram standing for nobody, on the one screen in the product an end consumer ever sees.
 *
 * The grounding rule the agent's answers live under applies to the chrome around them: who the
 * lead is talking to is a fact, and the honest one is the business. Every place that named a
 * person now names the business, and the per-turn avatars -- circles, which read as people ---
 * carry a glyph instead of initials. A named human turn still prints the name the server sent
 * with it; nothing invents one.
 *
 * It carries no `at`, and that is the same rule applied to time. This turn is composed here on
 * first render -- `ConsumerEntry` passes no `initialMessages`, so it is what a live lead opens on --
 * and it is never appended to the stored transcript, so no send time for it exists anywhere. It
 * used to be stamped `"10:04 AM"`, a value copied out of the artboard, so a stranger's conversation
 * opened at 10:04 whatever the hour it actually was. There is also nowhere honest to take a time
 * from: `new Date()` here would date the greeting to the moment the page loaded rather than to
 * anything sent, and it would be a zone-dependent string rendered during SSR, which is a hydration
 * mismatch on top of being a claim. An absent time is the true one.
 */
function welcomeMessage(businessName: string): ConsumerMessage {
  return {
    id: "welcome",
    author: "agent",
    text: `Hi, I’m ${businessName}’s appointment assistant. I can answer questions, check whether a strategy call makes sense, and help you choose a time. What are you working toward?`,
  };
}

const STARTERS = [
  "I need funding for my business",
  "I want to improve my credit",
  "I have a question first",
];

function messageId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

/**
 * What the "request a human" control promises, and what it says when no hours are stored.
 *
 * The absent arm used to read "Marcus's reply hours aren't configured yet", which is two defects
 * in one line: it names a person the product cannot name, and it tells a lead about the state of
 * their coach's configuration -- a sentence that means nothing to someone who does not know the
 * product has settings, and that reports the business as half-built to its own prospect. What
 * replaces it is the thing the request actually does: the handoff moves the conversation to
 * `needs_human`, so a person at the business sees it. No timing is promised, because no stored
 * hours exist to promise one from.
 */
function replyWindowCopy(
  window: HumanReplyWindow | null | undefined,
  businessName: string,
): { detail: string; short: string } {
  if (
    !window ||
    !Number.isFinite(window.replyWithinHours) ||
    window.replyWithinHours <= 0 ||
    !window.opensAt.trim() ||
    !window.closesAt.trim() ||
    !window.timeZoneLabel.trim()
  ) {
    return {
      detail: `Someone at ${businessName} will see your request`,
      short: "A person will see your request",
    };
  }

  const unit = window.replyWithinHours === 1 ? "hour" : "hours";
  return {
    detail: `${businessName} usually replies within ${window.replyWithinHours} ${unit}, ${window.opensAt} to ${window.closesAt} ${window.timeZoneLabel}`,
    short: `Replies within ${window.replyWithinHours}h, ${window.opensAt} to ${window.closesAt} ${window.timeZoneLabel}`,
  };
}

/**
 * The clock a chat timestamp is read on, which is the lead's own and no one else's.
 *
 * This used to pass `timeZone: COACH_TIME_ZONE`, so a lead in New York sent a message at 3:00 PM
 * and watched their own message appear as 2:00 PM. Nothing on the screen says whose clock it is, so
 * it does not read as a zone difference; it reads as the product being wrong about the last minute
 * of the reader's life. Omitting `timeZone` is what asks for the reader's own zone -- `Intl` then
 * resolves the host's, which on a lead's phone is the zone their phone is set to.
 *
 * The confirmed-appointment figures below are a different question and stay as they are: an
 * appointment has a zone the booking source asserted, and that zone is printed beside the time.
 *
 * Every call site is an event handler -- a sent turn, a read-back, a booking confirmation -- so
 * this never runs during the server render. That matters, because this surface *is* server
 * rendered: `src/app/consumer/page.tsx` renders `ConsumerExperience` directly on its preview branch,
 * and a zone-dependent string in the first paint is the textbook hydration mismatch. Nothing this
 * function produces is in the first paint, and the one turn that is -- the greeting -- carries no
 * time at all.
 */
function messageTime(): string {
  /*
   * The zone is resolved and passed, not omitted.
   *
   * Omitting it gets the same answer -- `Intl` falls back to the host zone either way -- and
   * `src/lib/format/datetime.test.ts` refuses it, correctly. That rule comes from issue #418,
   * where a server rendered in UTC and the browser re-rendered in the viewer's zone, and its
   * whole value is that it cannot be talked out of by an argument about call sites: "every
   * caller is an event handler today" is true and is not a property anything enforces, so the
   * day someone renders a transcript on the server the mismatch returns silently.
   *
   * Resolving it explicitly says which zone this is and why, and it is the shape the rule already
   * exempts by name -- `signup-form.tsx` reads the visitor's own zone the same way to prefill a
   * field. `resolvedOptions()` still runs only in an event handler, so nothing here reaches the
   * first paint.
   */
  const viewerZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: viewerZone,
  }).format(new Date());
}

/**
 * The zone an appointment should be read in.
 *
 * `label` carries whatever the booking source supplied: an IANA zone from the confirmation
 * (`"UTC"`, `"America/New_York"`), or a human phrase from an offered slot. The old test was
 * `label.includes("/")`, which accepted `America/New_York` and silently rejected `UTC` -- so a
 * server that confirmed an appointment in UTC had that answer discarded and the time reprinted in
 * the coach's zone, six hours out. Asking `Intl` whether it can use the value is the question
 * actually being asked, and a phrase it cannot use still falls back to the coach's zone.
 */
function resolveTimeZone(label: string): string {
  const candidate = label.trim();
  if (!candidate) return COACH_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return COACH_TIME_ZONE;
  }
}

/**
 * The confirmed appointment as three separate readings: the time, the day, and the zone.
 *
 * The booked panel states the time as a figure, which is what the lead came back to the screen to
 * check, with the day under it. One formatted string cannot do that -- a figure is a size and a
 * weight applied to one value, not to a sentence -- so the parts are formatted separately here
 * against the same zone.
 *
 * `null` when the appointment cannot be read, and the panel then falls back to its sentence rather
 * than printing a placeholder. A wrong time on this screen is worse than no time: the lead reads
 * it once and puts it in their day.
 */
function confirmedAppointmentParts(appointment: { slot: string; label: string }) {
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(appointment.slot)) return null;
  const date = new Date(appointment.slot);
  if (Number.isNaN(date.valueOf())) return null;
  const timeZone = resolveTimeZone(appointment.label);
  try {
    return {
      day: new Intl.DateTimeFormat("en-US", {
        day: "numeric",
        month: "long",
        timeZone,
        weekday: "long",
      }).format(date),
      time: new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone,
      }).format(date),
      zone: new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "long" })
        .formatToParts(date)
        .find((part) => part.type === "timeZoneName")?.value ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * The confirmed appointment as an `.ics` file, or `null` when it cannot be built honestly.
 *
 * Every field comes from the appointment the server confirmed. `DTEND` is the provider's own end
 * instant, never a length this code assumed: `appointments.end_at` is `not null` under an
 * `end_at > start_at` check, so a real one always exists, and if it fails to reach here the answer
 * is no file rather than a guess. A calendar entry of the wrong length is worse than no entry --
 * the lead reads it once, puts it in their day, and plans the hour after it around a number nobody
 * ever told them.
 *
 * Written in UTC (`...Z`), which is what a `Date` gives back and what every calendar client reads
 * without a VTIMEZONE block; the lead's own app renders it in their zone. `SUMMARY` names the
 * business and, when the coach has published one, their programme -- the same two facts the screen
 * already shows, so the file makes no claim the panel above it does not.
 */
function appointmentCalendarFile(
  appointment: { slot: string; endsAt: string | null },
  businessName: string,
  programName: string | null,
): { filename: string; href: string } | null {
  if (!appointment.endsAt) return null;
  const start = new Date(appointment.slot);
  const end = new Date(appointment.endsAt);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) return null;
  // The database guarantees this ordering; a violation here means the value is not what it claims.
  if (end.valueOf() <= start.valueOf()) return null;

  const stamp = (value: Date) => `${value.toISOString().replace(/[-:]/gu, "").split(".")[0]}Z`;
  // RFC 5545 escaping. A programme name with a comma in it must not become two properties.
  const escape = (value: string) =>
    value.replace(/\\/gu, "\\\\").replace(/;/gu, "\\;").replace(/,/gu, "\\,").replace(/\r?\n/gu, "\\n");
  const subject = programName?.trim()
    ? `${businessName}: ${programName.trim()}`
    : `Call with ${businessName}`;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SetterFi//Booked call//EN",
    "BEGIN:VEVENT",
    `UID:${stamp(start)}-${escape(businessName).slice(0, 40)}@setterfi`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${escape(subject)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return {
    filename: "call.ics",
    // CRLF, which RFC 5545 requires and which some desktop clients enforce strictly.
    href: `data:text/calendar;charset=utf-8,${encodeURIComponent(`${lines.join("\r\n")}\r\n`)}`,
  };
}

function displaySlot(booking: ConsumerBooking): string {
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(booking.slot)) return booking.slot;

  const date = new Date(booking.slot);
  if (Number.isNaN(date.valueOf())) return "Proposed time available";

  const timeZone = resolveTimeZone(booking.label);
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: COACH_TIME_ZONE,
    }).format(date);
  }
}

function HandoffDivider({ at }: { at?: string }): ReactElement {
  return (
    <div
      className="consumer-handoff-divider"
      data-derived-author="human"
      data-slot="consumer-message"
      role="listitem"
    >
      <span aria-hidden="true" />
      <span>
        <strong>Handed to a person</strong>
        {at ? <time>{at}</time> : null}
      </span>
      <span aria-hidden="true" />
    </div>
  );
}

function SystemMessageRow({ message }: { message: ConsumerMessage }): ReactElement {
  return (
    <div
      className="consumer-system-event"
      data-author={message.author}
      data-slot="consumer-message"
      role="listitem"
    >
      <span aria-hidden="true" />
      <div>
        <span>
          <strong>{message.text}</strong>
          {message.at ? <time>{message.at}</time> : null}
        </span>
        {message.detail ? <p>{message.detail}</p> : null}
      </div>
      <span aria-hidden="true" />
    </div>
  );
}

function ConsumerMessageRow({
  businessName,
  message,
}: {
  businessName: string;
  message: ConsumerMessage;
}): ReactElement {
  const isAgent = message.author === "agent";
  const isHuman = message.author === "human";

  return (
    <article
      className="consumer-message"
      data-author={message.author}
      data-slot="consumer-message"
      role="listitem"
    >
      {/*
        * A glyph, never initials. These avatars are circles, and the stylesheet says why -- a
        * circle reads as a person. Two letters inside one are a claim about who wrote the turn,
        * and the only turn whose writer the product knows is a human turn the server named.
        */}
      <span className="consumer-message__avatar" aria-hidden="true">
        {message.author === "lead" ? <UserRound data-slot="person-icon" /> : null}
        {isAgent ? <ChatIcon data-slot="assistant-icon" /> : null}
        {isHuman ? <UserRound data-slot="person-icon" /> : null}
      </span>
      <div className="consumer-message__body">
        {isHuman ? (
          <span className="consumer-message__human-author">
            {/* The name the server sent with the turn, or the business that sent it. Never a
                person this component picked. */}
            {message.authorName ?? businessName}
            {message.at ? <time>{message.at}</time> : null}
          </span>
        ) : null}
        <p>{message.text}</p>
        {isAgent ? (
          <span className="consumer-message__assistant-author">
            <span>Answered by the assistant</span>
            {message.at ? <time>{message.at}</time> : null}
          </span>
        ) : null}
        {message.author === "lead" ? (
          <span className="consumer-message__lead-author">
            <span>You</span>
            {message.at ? <time>{message.at}</time> : null}
          </span>
        ) : null}
      </div>
    </article>
  );
}

function needsHandoffDivider(
  messages: readonly ConsumerMessage[],
  index: number,
): boolean {
  const message = messages[index];
  if (message.author !== "human") return false;

  // System events (the handoff receipt itself) between the last assistant turn and the first
  // human turn do not suppress the divider; the authorship change is what the divider marks.
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    if (messages[previous].author === "system") continue;
    return messages[previous].author !== "human";
  }

  return false;
}

function isConsumerState(value: unknown): value is ConsumerState {
  return ["active", "booked", "nurture", "closed", "handoff", "opted_out"].includes(
    String(value),
  );
}

function authorRoleFromReadBack(turn: ConsumerTurn): "agent" | "human" | "system" {
  // The stored author role from the route is the authority; the state mapping only covers a
  // malformed payload so the UI never invents a human turn.
  if (turn.author) {
    return turn.author.role === "assistant" ? "agent" : turn.author.role;
  }
  return turn.state === "handoff" || turn.state === "opted_out" ? "system" : "agent";
}

export function ConsumerExperience({
  bookingConfirmEnabled = false,
  businessName = BUSINESS_NAME,
  channel = "web",
  humanReplyWindow = null,
  initialMessages,
  privacyHref = null,
  programName = null,
  sessionReference = null,
}: ConsumerExperienceProps) {
  // The opening turn names the business it is opening for. It used to be a module constant
  // greeting every lead on behalf of "Reid Funding Group", including a lead of some other coach.
  const openingMessages = useMemo(
    () => initialMessages ?? [welcomeMessage(businessName)],
    [businessName, initialMessages],
  );
  const [messages, setMessages] = useState<ConsumerMessage[]>(() => [...openingMessages]);
  const [thinking, setThinking] = useState(false);
  const [conversationState, setConversationState] = useState<ConsumerState>("active");
  const [booking, setBooking] = useState<ConsumerBooking | null>(null);
  /*
   * The appointment the server confirmed, kept so the booked panel can state it.
   *
   * It used to be thrown away the moment it arrived: the confirmation went into one system message
   * and `booking` was set to null, so the panel a lead lands on could say only that something was
   * reserved. The time is the whole reason they came back to the screen.
   */
  const [confirmedAppointment, setConfirmedAppointment] =
    useState<{ label: string; slot: string; endsAt: string | null } | null>(null);
  const [bookingPreviewShown, setBookingPreviewShown] = useState(false);
  const [handoffRequested, setHandoffRequested] = useState(false);
  const [handoffPending, setHandoffPending] = useState(false);
  const [humanActionError, setHumanActionError] = useState("");
  const [lastFailedMessage, setLastFailedMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const shellRef = useRef<HTMLElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const closedStateRef = useRef<HTMLDivElement>(null);
  const activeRequestRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);

  const configuredReplyWindow = useMemo(
    () => replyWindowCopy(humanReplyWindow, businessName),
    [businessName, humanReplyWindow],
  );

  const leadMessages = useMemo(
    () => messages.filter((message) => message.author === "lead"),
    [messages],
  );
  const conversationClosed =
    (conversationState === "booked" && !booking) ||
    conversationState === "closed" ||
    conversationState === "opted_out";
  /**
   * Whether this screen is currently stating a confirmed appointment, as one fact rather than two.
   *
   * `conversationState === "booked"` is not that fact and reading it as such is a claim, which is
   * how the header first got written: the preview path sets the state to booked and then tells the
   * lead in so many words that **no appointment was booked** (`bookingPreviewShown`), and a
   * server turn can hand back `booked` with a slot still awaiting confirmation, where the panel
   * says "Nothing is booked until you confirm". Either way the header would have announced a
   * confirmation over a screen denying one -- the dishonest state the product forbids, on the one
   * surface an end consumer sees.
   *
   * So it is derived once, next to `conversationClosed`, and both the header line and the drenched
   * closed panel read it. Two places deciding separately what "booked" means is the two-places-one-
   * number condition, and the place it would have shown up is a stranger's screen.
   */
  const appointmentConfirmed =
    conversationClosed && conversationState === "booked" && !bookingPreviewShown;

  /*
   * The closed state's copy, and -- via `data-state` on the element below -- its treatment.
   *
   * The state is stamped onto the markup because the stylesheet has to tell the three endings
   * apart: a booked call, an opt-out, and a conversation that simply closed. `consumer.css`
   * saturates only the first, because drenching an opt-out would dress a compliance stop up as an
   * outcome, on the one screen whose whole job is to be unambiguous about having stopped. The
   * attribute is the only markup this port adds and nothing but the stylesheet reads it; the copy
   * and the focus behaviour below are unchanged.
   */
  const closedStateCopy = conversationState === "booked"
    ? {
        title: `Booked with ${businessName}`,
        /*
         * What the artboard promises here and what the product can keep are two different
         * sentences. It says a reminder arrives the morning of the call and a calendar invite is
         * sent; nothing in the product generates either, and it also offers a RESCHEDULE keyword
         * that `suppression/keywords.ts` does not honour, which would be the product advertising a
         * control word it ignores. So the panel states the reservation and how the details reach
         * them, and promises no message the system does not send.
         */
        detail: "Your time is reserved. The business will send the appointment details separately.",
      }
    : conversationState === "opted_out"
      /*
       * The opt-out confirmation, and it is a compliance artefact rather than a UI string.
       *
       * It used to read "You're opted out. You won't receive any further messages", which names
       * nobody, scopes nothing, and leaves a person who changes their mind with no way back. The
       * three things a revocation confirmation owes the reader are the business they are
       * unsubscribed from, the scope of the stop, and the keyword that reverses it -- and all
       * three are facts this component already holds or that `suppression/keywords.ts` already
       * honours: START is a recognised control word, so offering it is a promise the system keeps.
       *
       * START is a *phone* control word -- `PHONE_CONTROL_CHANNELS` is sms and whatsapp -- so it
       * is only offered on a phone-bearing channel. On web there is no number and no keyword, and
       * saying otherwise would be the kind of instruction that reads as compliant and does
       * nothing.
       */
      ? {
          title: `You’re unsubscribed from ${businessName}`,
          detail: channel === "sms"
            ? "You won’t get any more messages from this number. Reply START if you ever want to hear from us again."
            : "You won’t get any more messages in this conversation.",
        }
      : { title: "Conversation closed", detail: "Start over if you’d like to try a different path." };

  /*
   * The calendar file, and `null` whenever it cannot be built from confirmed values -- no end
   * instant, an unparseable one, or one that does not come after the start. There is no fallback
   * duration anywhere in this path on purpose: a lead who adds a wrong-length block to their
   * calendar plans the hour after it around a number nobody told them, which is worse than having
   * to write the time down themselves.
   */
  const calendarFile = useMemo(
    () =>
      conversationState === "booked" && confirmedAppointment
        ? appointmentCalendarFile(confirmedAppointment, businessName, programName)
        : null,
    [businessName, confirmedAppointment, conversationState, programName],
  );

  const bookedParts = useMemo(
    () =>
      conversationState === "booked" && confirmedAppointment
        ? confirmedAppointmentParts(confirmedAppointment)
        : null,
    [confirmedAppointment, conversationState],
  );

  useEffect(() => () => activeRequestRef.current?.abort(), []);

  useEffect(() => {
    const viewport = window.visualViewport;
    const shell = shellRef.current;
    if (!viewport || !shell) return;

    const syncViewportHeight = () => {
      shell.style.height = `${viewport.height}px`;
    };

    syncViewportHeight();
    viewport.addEventListener("resize", syncViewportHeight);
    return () => viewport.removeEventListener("resize", syncViewportHeight);
  }, []);

  useEffect(() => {
    const region = conversationRef.current;
    if (!region) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    region.scrollTo?.({
      top: region.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [booking, bookingPreviewShown, handoffRequested, messages, thinking]);

  useEffect(() => {
    if (!conversationClosed) return;

    const frame = window.requestAnimationFrame(() => closedStateRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [conversationClosed, conversationState]);

  async function postConsumerTurn(
    message: string,
    signal: AbortSignal,
  ): Promise<ConsumerTurn> {
    const response = await fetch("/api/consumer-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sessionReference
        ? { action: "turn", message, sessionReference }
        : {
            message,
            history: leadMessages.slice(-6).map((item) => item.text.slice(0, 800)),
          }),
      signal,
    });
    const result = (await response.json()) as Partial<ConsumerTurn> & { error?: string };

    if (
      !response.ok ||
      typeof result.reply !== "string" ||
      !isConsumerState(result.state) ||
      !("booking" in result)
    ) {
      throw new Error(result.error || "Your message didn’t go through.");
    }

    return result as ConsumerTurn;
  }

  function applyTurnReadBack(turn: ConsumerTurn, leadText?: string): void {
    const at = messageTime();
    const author = authorRoleFromReadBack(turn);
    setMessages((current) => [
      ...current,
      ...(leadText
        ? [{ id: messageId(), author: "lead" as const, text: leadText, at }]
        : []),
      {
        id: messageId(),
        author,
        text: turn.reply,
        at,
        ...(author === "human" && turn.author?.name ? { authorName: turn.author.name } : {}),
        ...(author === "system"
          ? { detail: configuredReplyWindow.detail }
          : {}),
      },
    ]);
    setConversationState(turn.state);
    setBooking(turn.booking);
    setBookingPreviewShown(false);
    setHandoffRequested((current) => turn.state === "handoff" || current);
    setHumanActionError("");
    setAnnouncement(turn.reply);
  }

  async function sendMessage(rawMessage: string): Promise<void> {
    const message = rawMessage.trim();
    if (!message || thinking || conversationClosed) return;

    const requestSequence = ++requestSequenceRef.current;
    const controller = new AbortController();
    activeRequestRef.current?.abort();
    activeRequestRef.current = controller;
    setThinking(true);
    setLastFailedMessage(null);
    setHumanActionError("");
    setAnnouncement(`${businessName}’s assistant is typing.`);

    try {
      const turn = await postConsumerTurn(message, controller.signal);
      if (requestSequence !== requestSequenceRef.current) return;
      applyTurnReadBack(turn, message);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (requestSequence !== requestSequenceRef.current) return;

      setLastFailedMessage(message);
      if (handoffRequested) {
        setHumanActionError("Your message wasn’t queued. Check your connection and try again.");
        setAnnouncement("Your message wasn’t queued.");
      } else {
        setAnnouncement("Your message didn’t go through. You can retry it.");
      }
    } finally {
      if (requestSequence === requestSequenceRef.current) {
        activeRequestRef.current = null;
        setThinking(false);
      }
    }
  }

  async function confirmBooking(): Promise<void> {
    if (!booking || thinking) return;
    if (!bookingConfirmEnabled) {
      setBookingPreviewShown(true);
      setAnnouncement("Preview only. No appointment was booked.");
      return;
    }
    if (!sessionReference || !booking.id) {
      setHumanActionError("This time could not be confirmed because its booking receipt is missing.");
      setAnnouncement("The appointment was not booked.");
      return;
    }

    const requestSequence = ++requestSequenceRef.current;
    const controller = new AbortController();
    activeRequestRef.current?.abort();
    activeRequestRef.current = controller;
    setThinking(true);
    setHumanActionError("");
    setAnnouncement("Confirming your appointment.");

    try {
      const response = await fetch("/api/consumer-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "confirm-booking",
          selectedSlotId: booking.id,
          sessionReference,
        }),
        signal: controller.signal,
      });
      const payload: unknown = await response.json();
      const appointment = payload && typeof payload === "object" && "appointment" in payload
        ? (payload as { appointment?: unknown }).appointment
        : null;
      if (
        !response.ok ||
        !appointment ||
        typeof appointment !== "object" ||
        typeof (appointment as { appointmentId?: unknown }).appointmentId !== "string" ||
        typeof (appointment as { startAt?: unknown }).startAt !== "string"
      ) {
        const error = payload && typeof payload === "object" && "error" in payload
          ? String((payload as { error?: unknown }).error)
          : "This time could not be confirmed.";
        throw new Error(error);
      }
      if (requestSequence !== requestSequenceRef.current) return;
      const confirmed = appointment as {
        appointmentId: string; startAt: string; endAt?: string; timezone?: string;
      };
      const confirmedBooking = {
        slot: confirmed.startAt,
        label: typeof confirmed.timezone === "string" ? confirmed.timezone : booking.label,
        // Absent rather than assumed. Nothing downstream substitutes a length for a missing one.
        endsAt: typeof confirmed.endAt === "string" ? confirmed.endAt : null,
      };
      const confirmation = `Your appointment is confirmed for ${displaySlot(confirmedBooking)}.`;
      setMessages((current) => [...current, {
        id: messageId(),
        author: "system",
        text: confirmation,
        at: messageTime(),
      }]);
      setConversationState("booked");
      setConfirmedAppointment(confirmedBooking);
      setBooking(null);
      setAnnouncement(confirmation);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (requestSequence !== requestSequenceRef.current) return;
      setHumanActionError(error instanceof Error ? error.message : "This time could not be confirmed.");
      setAnnouncement("The appointment was not booked.");
    } finally {
      if (requestSequence === requestSequenceRef.current) {
        activeRequestRef.current = null;
        setThinking(false);
      }
    }
  }

  async function requestHandoff(): Promise<void> {
    // While a lead message is in flight, starting handoff would abort it and silently discard
    // the turn; the control is disabled below for the same reason.
    if (thinking || handoffRequested || handoffPending || conversationState === "opted_out") return;

    const requestSequence = ++requestSequenceRef.current;
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setThinking(false);
    setHandoffPending(true);
    setHumanActionError("");
    setAnnouncement("Saving your human request.");
    try {
      const turn = await postConsumerTurn("Talk to a human", controller.signal);
      if (requestSequence !== requestSequenceRef.current) return;
      if (turn.state !== "handoff") throw new Error("The human request was not saved.");
      applyTurnReadBack(turn);
      setAnnouncement(`${configuredReplyWindow.detail}. You can keep messaging here.`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (requestSequence !== requestSequenceRef.current) return;
      setHumanActionError("Your human request wasn’t saved. Check your connection and try again.");
      setAnnouncement("Your human request wasn’t saved.");
    } finally {
      if (requestSequence === requestSequenceRef.current) {
        activeRequestRef.current = null;
        setHandoffPending(false);
      }
    }
  }

  function restart(): void {
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    requestSequenceRef.current += 1;
    setMessages([...openingMessages]);
    setThinking(false);
    setConversationState("active");
    setBooking(null);
    setConfirmedAppointment(null);
    setBookingPreviewShown(false);
    setHandoffRequested(false);
    setHandoffPending(false);
    setHumanActionError("");
    setLastFailedMessage(null);
    setAnnouncement("Conversation restarted.");
  }

  return (
    <main className="consumer-shell" ref={shellRef}>
      <a className="consumer-skip-link" href="#message-composer">
        Skip to message composer
      </a>

      <div className="consumer-stage">
        <section className="consumer-frame" aria-label={`Chat with ${businessName}`}>
          {sessionReference ? (
            <div className="consumer-preview-ribbon" role="note">
              <strong>Live conversation</strong>
              <span aria-hidden="true">·</span>
              <span>Your messages and confirmed appointments are saved</span>
            </div>
          ) : (
            <div className="consumer-preview-ribbon" role="note">
              <strong>Preview</strong>
              <span aria-hidden="true">·</span>
              <span>Synthetic conversation, not a live lead</span>
            </div>
          )}

          <div className="consumer-chat-body">
          <header className="consumer-header">
            {/*
              * The business's mark: a rounded square, per the stylesheet, and initials derived
              * from the name printed beside it rather than a two-letter constant. `initialsFor`
              * is the kit's own derivation, so nothing here can ship a wrong pair of letters.
              */}
            <span className="consumer-avatar" aria-hidden="true">{initialsFor(businessName)}</span>
            <div className="consumer-identity">
              <h1>{businessName}</h1>
              {/*
                * What the lead is talking to, or -- once there is one -- the thing they came back
                * to the screen to check.
                *
                * The canvas spends this slot on a state readout rather than a constant: it draws
                * a reply line on the open conversation, the business's number on the opt-out, and
                * "Your call is confirmed" on the booked screen (`ConsumerBooked.dc.html:68`).
                * Two of those three have no source here -- no stored reply hours, and no phone
                * number on a web session -- and inventing either is the defect this file's
                * identity docblock exists about. The third does: `conversationState` is already
                * held, the booked arm is already the one the closed-state panel drenches, and the
                * sentence is true exactly when it renders -- `appointmentConfirmed`, so the line
                * and the panel cannot disagree about what was booked.
                *
                * So the slot follows the state where the state is knowable and falls back to what
                * the product can always say. It does not know who owns the business, so it still
                * does not say.
                */}
              <p>
                {appointmentConfirmed ? "Your call is confirmed" : "Appointment assistant"}
              </p>
            </div>
            <div className="consumer-human-action">
              <button
                aria-label="Request a human"
                aria-describedby="consumer-human-window"
                className="consumer-human-button"
                type="button"
                onClick={() => void requestHandoff()}
                aria-busy={handoffPending}
                disabled={
                  thinking ||
                  handoffRequested ||
                  handoffPending ||
                  conversationState === "opted_out"
                }
              >
                <UserRound aria-hidden="true" />
                <span className="consumer-human-button__long">Request a human</span>
                <span className="consumer-human-button__short" aria-hidden="true">Human</span>
              </button>
              <span className="consumer-human-window" id="consumer-human-window">{configuredReplyWindow.detail}</span>
              <span className="consumer-human-window-short" aria-hidden="true">{configuredReplyWindow.short}</span>
            </div>
          </header>

          <div className="consumer-disclosure">
            <span>
              You’re chatting with {businessName}’s assistant. It’s automated, and you can ask for a person at any time.
            </span>
            {privacyHref ? <> <a href={privacyHref}>Privacy policy</a></> : null}
          </div>

          <div
            aria-busy={thinking}
            aria-label="Conversation messages"
            aria-live="off"
            className="consumer-conversation"
            ref={conversationRef}
            role="log"
          >
            <div className="consumer-day-label">Today</div>
            <div className="consumer-message-list" role="list">
              {messages.map((message, index) => (
                <Fragment key={message.id}>
                  {needsHandoffDivider(messages, index) ? (
                    <HandoffDivider at={message.at} />
                  ) : null}
                  {message.author === "system" ? (
                    <SystemMessageRow message={message} />
                  ) : (
                    <ConsumerMessageRow businessName={businessName} message={message} />
                  )}
                </Fragment>
              ))}

              {thinking ? (
                <div className="consumer-typing" aria-label="Assistant is typing" role="listitem">
                  <span className="consumer-message__avatar" aria-hidden="true"><ChatIcon /></span>
                  <span aria-hidden="true"><i /><i /><i /></span>
                </div>
              ) : null}

              {lastFailedMessage && !thinking ? (
                <div className="consumer-inline-state" data-tone="error" role="listitem">
                  <div>
                    <strong>Your message didn’t go through</strong>
                    <span>Check your connection and try again.</span>
                  </div>
                  <button type="button" onClick={() => void sendMessage(lastFailedMessage)}>
                    <Refresh aria-hidden="true" /> Retry
                  </button>
                </div>
              ) : null}

              {humanActionError ? (
                <div className="consumer-inline-state" data-tone="error" role="listitem">
                  <div>
                    <strong>Nothing was marked complete</strong>
                    <span>{humanActionError}</span>
                  </div>
                </div>
              ) : null}

              {booking ? (
                <section className="consumer-booking" aria-labelledby="consumer-booking-title" role="listitem">
                  <div className="consumer-booking__copy">
                    {bookingPreviewShown ? (
                      <>
                        <span>Preview outcome</span>
                        <h2 id="consumer-booking-title">
                          <CalendarDays aria-hidden="true" />
                          No appointment was booked
                        </h2>
                        <p>
                          This is a preview. On a live workspace, this is where the appointment would be written to Calendar and the details sent here.
                        </p>
                      </>
                    ) : (
                      <>
                        <span>A time is available</span>
                        <h2 id="consumer-booking-title">
                          <CalendarDays aria-hidden="true" />
                          {displaySlot(booking)}
                        </h2>
                        <p>Call with {businessName}. Nothing is booked until you confirm.</p>
                      </>
                    )}
                  </div>
                  {!bookingPreviewShown ? (
                    <button
                      className="consumer-primary-button"
                      type="button"
                      onClick={() => void confirmBooking()}
                    >
                      Confirm time
                    </button>
                  ) : null}
                </section>
              ) : null}
            </div>
          </div>

          <footer className="consumer-composer-shell">
            {!conversationClosed ? (
              <>
                <div className="consumer-starters" aria-label="Suggested replies">
                  <span>Suggested</span>
                  {STARTERS.map((starter) => (
                    <button
                      type="button"
                      key={starter}
                      onClick={() => void sendMessage(starter).catch(() => undefined)}
                      disabled={thinking}
                    >
                      {starter}
                    </button>
                  ))}
                </div>
                <Composer
                  onSend={sendMessage}
                  placeholder={`Message ${businessName}…`}
                  sending={thinking}
                />
                {thinking ? (
                  <p className="consumer-composer-status">You can keep typing while the assistant replies</p>
                ) : null}
              </>
            ) : (
              <>
              <div
                className="consumer-closed-state"
                data-state={conversationState}
                ref={closedStateRef}
                tabIndex={-1}
              >
                {/*
                  * The padlock, on the opt-out arm only.
                  *
                  * The composer is gone in all three closed states and only one of them is a stop
                  * the lead chose. Without a mark the strip reads the same whether the
                  * conversation ended, was booked, or was deliberately unsubscribed from, and the
                  * one that has to be unmistakable is the compliance stop. It is decorative: the
                  * sentence beside it carries the whole statement, so nothing here is said by a
                  * glyph alone.
                  *
                  * The booked arm now carries a tick on the same reasoning read the other way.
                  * The rule was never "mark the opt-out", it was "the three endings must not read
                  * alike", and marking one of three leaves the other two still telling each other
                  * apart by their sentence alone -- so the argument above was applied to a third
                  * of its own subject. `ConsumerBooked.dc.html:76-79` draws this tick, and it is
                  * the confirmation glyph missing from the one screen whose entire job is
                  * confirming. The plain `closed` arm keeps no mark deliberately: a conversation
                  * that simply ended is not an outcome, and a glyph would dress it as one.
                  *
                  * Both marks are `aria-hidden` and neither says anything the strong and the
                  * sentence beside it do not already say in words.
                  */}
                {conversationState === "opted_out" ? (
                  <span aria-hidden="true" className="consumer-closed-state__mark">
                    <Lock />
                  </span>
                ) : null}
                {conversationState === "booked" ? (
                  <span
                    aria-hidden="true"
                    className="consumer-closed-state__mark"
                    data-state="booked"
                  >
                    <Check />
                  </span>
                ) : null}
                <div>
                  <strong>{closedStateCopy.title}</strong>
                  {bookedParts ? (
                    <>
                      {/* The time as a figure, which is what the lead reopened the screen for,
                          with the day under it and the zone spelled out. Every part is the
                          appointment the server confirmed; none of it is derived from the slot
                          that was offered. */}
                      <p className="consumer-closed-state__figure">{bookedParts.time}</p>
                      <span className="consumer-closed-state__day">{bookedParts.day}</span>
                      {bookedParts.zone ? <span>{bookedParts.zone}</span> : null}
                    </>
                  ) : null}
                  <span>{closedStateCopy.detail}</span>
                </div>
                {!sessionReference ? (
                  <button type="button" onClick={restart}>
                    <Refresh aria-hidden="true" /> Start over
                  </button>
                ) : null}
              </div>
              {/*
                * "What the call is about", carrying the one fact the product actually stores.
                *
                * It is a sibling of the booked panel rather than a block inside it, because the
                * artboard's whole point on this screen is that exactly one thing is saturated --
                * the time -- and everything else is a plain card underneath it. A second block on
                * the drench would make the programme name compete with the value the lead
                * reopened the screen to read.
                *
                * The name and nothing else. See the `programName` prop for why the artboard's
                * length, direction and agenda are absent: none of them exist as stored data, and
                * a lead reading a description of their own call has no way to tell an approved
                * sentence from an invented one.
                */}
              {conversationState === "booked" && programName?.trim() ? (
                <div className="consumer-booked-subject">
                  <span className="consumer-booked-subject__label">What the call is about</span>
                  <p className="consumer-booked-subject__value">{programName.trim()}</p>
                </div>
              ) : null}
              {/*
                * "Add to my calendar", built from the appointment the server confirmed and from
                * nothing else. It is absent rather than disabled when the file cannot be built:
                * a control that is visibly present and does nothing reads as the product being
                * broken, while its absence is simply a screen that does not offer something.
                *
                * A plain anchor with `download` rather than a scripted save, so it works with the
                * lead's own browser rather than against it, and the href is a data URI so no
                * request leaves the phone to fetch it.
                */}
              {calendarFile ? (
                <a
                  className="consumer-booked-calendar"
                  download={calendarFile.filename}
                  href={calendarFile.href}
                >
                  <CalendarDays aria-hidden="true" />
                  Add to my calendar
                </a>
              ) : null}
              </>
            )}
            <p className="consumer-composer-note">
              Don’t share SSNs or account numbers
              {channel === "sms" ? <span> · Reply STOP to opt out</span> : null}
            </p>
          </footer>
          </div>
        </section>

        <aside className="consumer-context" aria-label={`About ${businessName}`}>
          <span className="consumer-context__eyebrow">A clearer next step</span>
          <h2>Funding questions deserve a real conversation.</h2>
          <p className="consumer-context__mobile-line">Ask for a person at any point and the assistant steps aside.</p>
          <p className="consumer-context__intro">
            Share what you’re working toward. We’ll help you understand whether a strategy call with {businessName} makes sense, without asking for sensitive account details.
          </p>
          <ul className="consumer-context__promises">
            <li>
              <ChatIcon aria-hidden="true" />
              <span><strong>Start with your situation</strong>Ask a question or describe your goal in your own words.</span>
            </li>
            <li>
              <UserRound aria-hidden="true" data-slot="person-icon" />
              <span><strong>A person is always available</strong>Ask for a person at any point and the assistant steps aside.</span>
            </li>
            <li>
              <ShieldCheck aria-hidden="true" />
              <span><strong>Your privacy comes first</strong>Keep SSNs, passwords and account numbers out of the chat.</span>
            </li>
          </ul>
        </aside>
      </div>

      <p className="consumer-live-region" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </main>
  );
}

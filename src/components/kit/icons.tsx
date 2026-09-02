"use client";

/**
 * The one sanctioned icon entry for the kit.
 *
 * Two families live here and nothing else does:
 *
 *  1. **Phosphor glyphs**, re-exported through a thin wrapper that fixes weight ("regular"),
 *     size (16) and colour (currentColor). Importing Phosphor directly anywhere else re-opens
 *     the door to mixed weights and mixed sizes in the same row, which is what made the old
 *     lucide sprawl read as three different products stitched together.
 *  2. **Six bespoke marks** drawn on a 16px grid at 1.5 stroke with round caps. These are the
 *     states the product actually has (SMS, booked, live, vetting, paused, test data) and no
 *     icon set draws them the way we mean them, so they are ours.
 *
 * The nav gets no icons at all -- it stays text-only by design. Icons appear only where a row,
 * a tile, or a control specifically calls for one.
 *
 * Deep `dist/ssr` imports rather than the package barrel: the barrel pulls every glyph in the
 * set into the module graph, and the SSR variants render on the server without a client
 * boundary of their own.
 */

import { ArrowDownIcon as ArrowDownGlyph } from "@phosphor-icons/react/dist/ssr/ArrowDown";
import { ArrowLeftIcon as ArrowLeftGlyph } from "@phosphor-icons/react/dist/ssr/ArrowLeft";
import { ArrowRightIcon as ArrowRightGlyph } from "@phosphor-icons/react/dist/ssr/ArrowRight";
import { ArrowSquareOutIcon as ArrowSquareOutGlyph } from "@phosphor-icons/react/dist/ssr/ArrowSquareOut";
import { ArrowUpIcon as ArrowUpGlyph } from "@phosphor-icons/react/dist/ssr/ArrowUp";
import { ArrowsClockwiseIcon as ArrowsClockwiseGlyph } from "@phosphor-icons/react/dist/ssr/ArrowsClockwise";
import { BellIcon as BellGlyph } from "@phosphor-icons/react/dist/ssr/Bell";
import { CalendarBlankIcon as CalendarBlankGlyph } from "@phosphor-icons/react/dist/ssr/CalendarBlank";
import { CalendarCheckIcon as CalendarCheckGlyph } from "@phosphor-icons/react/dist/ssr/CalendarCheck";
import { CalendarDotsIcon as CalendarDotsGlyph } from "@phosphor-icons/react/dist/ssr/CalendarDots";
import { CameraIcon as CameraGlyph } from "@phosphor-icons/react/dist/ssr/Camera";
import { CaretDownIcon as CaretDownGlyph } from "@phosphor-icons/react/dist/ssr/CaretDown";
import { CaretLeftIcon as CaretLeftGlyph } from "@phosphor-icons/react/dist/ssr/CaretLeft";
import { CaretRightIcon as CaretRightGlyph } from "@phosphor-icons/react/dist/ssr/CaretRight";
import { CaretUpIcon as CaretUpGlyph } from "@phosphor-icons/react/dist/ssr/CaretUp";
import { CaretUpDownIcon as CaretUpDownGlyph } from "@phosphor-icons/react/dist/ssr/CaretUpDown";
import { ChatCircleIcon as ChatCircleGlyph } from "@phosphor-icons/react/dist/ssr/ChatCircle";
import { ChatTextIcon as ChatTextGlyph } from "@phosphor-icons/react/dist/ssr/ChatText";
import { ChatsCircleIcon as ChatsCircleGlyph } from "@phosphor-icons/react/dist/ssr/ChatsCircle";
import { CheckIcon as CheckGlyph } from "@phosphor-icons/react/dist/ssr/Check";
import { CheckCircleIcon as CheckCircleGlyph } from "@phosphor-icons/react/dist/ssr/CheckCircle";
import { CircleIcon as CircleGlyph } from "@phosphor-icons/react/dist/ssr/Circle";
import { CircleDashedIcon as CircleDashedGlyph } from "@phosphor-icons/react/dist/ssr/CircleDashed";
import { CircleNotchIcon as CircleNotchGlyph } from "@phosphor-icons/react/dist/ssr/CircleNotch";
import { ClockIcon as ClockGlyph } from "@phosphor-icons/react/dist/ssr/Clock";
import { ColumnsIcon as ColumnsGlyph } from "@phosphor-icons/react/dist/ssr/Columns";
import { CommandIcon as CommandGlyph } from "@phosphor-icons/react/dist/ssr/Command";
import { CopyIcon as CopyGlyph } from "@phosphor-icons/react/dist/ssr/Copy";
import { CreditCardIcon as CreditCardGlyph } from "@phosphor-icons/react/dist/ssr/CreditCard";
import { DeviceMobileIcon as DeviceMobileGlyph } from "@phosphor-icons/react/dist/ssr/DeviceMobile";
import { DotsThreeIcon as DotsThreeGlyph } from "@phosphor-icons/react/dist/ssr/DotsThree";
import { DownloadSimpleIcon as DownloadSimpleGlyph } from "@phosphor-icons/react/dist/ssr/DownloadSimple";
import { EyeIcon as EyeGlyph } from "@phosphor-icons/react/dist/ssr/Eye";
import { EyeSlashIcon as EyeSlashGlyph } from "@phosphor-icons/react/dist/ssr/EyeSlash";
import { FacebookLogoIcon as FacebookLogoGlyph } from "@phosphor-icons/react/dist/ssr/FacebookLogo";
import { FileIcon as FileGlyph } from "@phosphor-icons/react/dist/ssr/File";
import { FileArchiveIcon as FileArchiveGlyph } from "@phosphor-icons/react/dist/ssr/FileArchive";
import { FileAudioIcon as FileAudioGlyph } from "@phosphor-icons/react/dist/ssr/FileAudio";
import { FileCodeIcon as FileCodeGlyph } from "@phosphor-icons/react/dist/ssr/FileCode";
import { FileTextIcon as FileTextGlyph } from "@phosphor-icons/react/dist/ssr/FileText";
import { FileVideoIcon as FileVideoGlyph } from "@phosphor-icons/react/dist/ssr/FileVideo";
import { FileZipIcon as FileZipGlyph } from "@phosphor-icons/react/dist/ssr/FileZip";
import { FlaskIcon as FlaskGlyph } from "@phosphor-icons/react/dist/ssr/Flask";
import { FunnelSimpleIcon as FunnelSimpleGlyph } from "@phosphor-icons/react/dist/ssr/FunnelSimple";
import { GearSixIcon as GearSixGlyph } from "@phosphor-icons/react/dist/ssr/GearSix";
import { InfoIcon as InfoGlyph } from "@phosphor-icons/react/dist/ssr/Info";
import { InstagramLogoIcon as InstagramLogoGlyph } from "@phosphor-icons/react/dist/ssr/InstagramLogo";
import { ListIcon as ListGlyph } from "@phosphor-icons/react/dist/ssr/List";
import { LockIcon as LockGlyph } from "@phosphor-icons/react/dist/ssr/Lock";
import { MagnifyingGlassIcon as MagnifyingGlassGlyph } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import { MoonIcon as MoonGlyph } from "@phosphor-icons/react/dist/ssr/Moon";
import { PaperPlaneTiltIcon as PaperPlaneTiltGlyph } from "@phosphor-icons/react/dist/ssr/PaperPlaneTilt";
import { PauseIcon as PauseGlyph } from "@phosphor-icons/react/dist/ssr/Pause";
import { PhoneIcon as PhoneGlyph } from "@phosphor-icons/react/dist/ssr/Phone";
import { PlayIcon as PlayGlyph } from "@phosphor-icons/react/dist/ssr/Play";
import { QuestionIcon as QuestionGlyph } from "@phosphor-icons/react/dist/ssr/Question";
import { RobotIcon as RobotGlyph } from "@phosphor-icons/react/dist/ssr/Robot";
import { ShieldCheckIcon as ShieldCheckGlyph } from "@phosphor-icons/react/dist/ssr/ShieldCheck";
import { ShieldWarningIcon as ShieldWarningGlyph } from "@phosphor-icons/react/dist/ssr/ShieldWarning";
import { SidebarSimpleIcon as SidebarSimpleGlyph } from "@phosphor-icons/react/dist/ssr/SidebarSimple";
import { SlidersHorizontalIcon as SlidersHorizontalGlyph } from "@phosphor-icons/react/dist/ssr/SlidersHorizontal";
import { SortAscendingIcon as SortAscendingGlyph } from "@phosphor-icons/react/dist/ssr/SortAscending";
import { SortDescendingIcon as SortDescendingGlyph } from "@phosphor-icons/react/dist/ssr/SortDescending";
import { SparkleIcon as SparkleGlyph } from "@phosphor-icons/react/dist/ssr/Sparkle";
import { SunIcon as SunGlyph } from "@phosphor-icons/react/dist/ssr/Sun";
import { TrayIcon as TrayGlyph } from "@phosphor-icons/react/dist/ssr/Tray";
import { UserIcon as UserGlyph } from "@phosphor-icons/react/dist/ssr/User";
import { UserCircleIcon as UserCircleGlyph } from "@phosphor-icons/react/dist/ssr/UserCircle";
import { WarningIcon as WarningGlyph } from "@phosphor-icons/react/dist/ssr/Warning";
import { WarningCircleIcon as WarningCircleGlyph } from "@phosphor-icons/react/dist/ssr/WarningCircle";
import { WarningOctagonIcon as WarningOctagonGlyph } from "@phosphor-icons/react/dist/ssr/WarningOctagon";
import { XIcon as XGlyph } from "@phosphor-icons/react/dist/ssr/X";
import { XCircleIcon as XCircleGlyph } from "@phosphor-icons/react/dist/ssr/XCircle";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import type { ComponentType, SVGProps } from "react";

import { cn } from "@/lib/utils";

/** Every icon in the product is 16px unless a caller has a specific reason not to be. */
export const KIT_ICON_SIZE = 16;

export type KitIconProps = Omit<SVGProps<SVGSVGElement>, "ref"> & {
  /** Pixel box. 16 unless a caller has a specific reason -- an empty-state glyph, say. */
  size?: number;
  /**
   * A label makes the glyph the accessible name of whatever it sits in. Without one the glyph is
   * decorative and hidden from the reader, which is the right default: nearly every icon here
   * sits beside a text label that already says the same thing.
   */
  label?: string;
};

type KitIcon = ComponentType<KitIconProps>;

/**
 * Fixes weight, size and colour so a caller cannot accidentally ship a bold glyph next to a
 * regular one. `size` and `className` stay open because a 20px glyph in an empty state is a real
 * need; weight and colour are not adjustable at all.
 */
function phosphor(Glyph: PhosphorIcon, displayName: string): KitIcon {
  function Wrapped({ className, label, size = KIT_ICON_SIZE, ...rest }: KitIconProps) {
    return (
      <Glyph
        aria-hidden={label ? undefined : true}
        aria-label={label}
        role={label ? "img" : undefined}
        {...rest}
        className={cn("shrink-0", className)}
        color="currentColor"
        size={size}
        weight="regular"
      />
    );
  }
  Wrapped.displayName = displayName;
  return Wrapped;
}

/* The agreed feature glyphs: the channels, the calendar, the transport controls, the palette. */
export const ChatIcon = phosphor(ChatCircleGlyph, "ChatIcon");
export const CalendarCheck = phosphor(CalendarCheckGlyph, "CalendarCheck");
export const InstagramLogo = phosphor(InstagramLogoGlyph, "InstagramLogo");
export const FacebookLogo = phosphor(FacebookLogoGlyph, "FacebookLogo");
export const Phone = phosphor(PhoneGlyph, "Phone");
export const Play = phosphor(PlayGlyph, "Play");
export const Pause = phosphor(PauseGlyph, "Pause");
export const Clock = phosphor(ClockGlyph, "Clock");
export const CommandKey = phosphor(CommandGlyph, "CommandKey");
export const Copy = phosphor(CopyGlyph, "Copy");
/* The card mark `CoachAccountMenu.dc.html:218` draws beside Billing -- a rounded rectangle with a
   magnetic stripe across it, which is what Phosphor's CreditCard is. Added rather than borrowed
   from a near-enough glyph because the row it labels is the one a worried coach is looking for. */
export const CreditCard = phosphor(CreditCardGlyph, "CreditCard");
export const SortAscending = phosphor(SortAscendingGlyph, "SortAscending");
export const SortDescending = phosphor(SortDescendingGlyph, "SortDescending");
export const SortNone = phosphor(CaretUpDownGlyph, "SortNone");

/*
 * The chrome glyphs. They keep their familiar names so a reader of a kit component still knows
 * what a `<ChevronDown />` is, but they are Phosphor underneath and they come from here, which is
 * the whole point: one weight, one size, one import path for every icon in the product.
 */
export const ArrowDown = phosphor(ArrowDownGlyph, "ArrowDown");
export const ArrowUp = phosphor(ArrowUpGlyph, "ArrowUp");
export const Bell = phosphor(BellGlyph, "Bell");
export const Bot = phosphor(RobotGlyph, "Bot");
export const Check = phosphor(CheckGlyph, "Check");
export const ChevronDown = phosphor(CaretDownGlyph, "ChevronDown");
export const ChevronLeft = phosphor(CaretLeftGlyph, "ChevronLeft");
export const ChevronRight = phosphor(CaretRightGlyph, "ChevronRight");
export const ChevronsUpDown = phosphor(CaretUpDownGlyph, "ChevronsUpDown");
export const Circle = phosphor(CircleGlyph, "Circle");
export const CircleAlert = phosphor(WarningCircleGlyph, "CircleAlert");
export const CircleCheck = phosphor(CheckCircleGlyph, "CircleCheck");
export const CircleX = phosphor(XCircleGlyph, "CircleX");
export const Columns = phosphor(ColumnsGlyph, "Columns");
export const Download = phosphor(DownloadSimpleGlyph, "Download");
export const ExternalLink = phosphor(ArrowSquareOutGlyph, "ExternalLink");
export const EyeOff = phosphor(EyeSlashGlyph, "EyeOff");
export const FileJson = phosphor(FileCodeGlyph, "FileJson");
export const Inbox = phosphor(TrayGlyph, "Inbox");
export const Info = phosphor(InfoGlyph, "Info");
export const ListFilter = phosphor(FunnelSimpleGlyph, "ListFilter");
export const Lock = phosphor(LockGlyph, "Lock");
export const Menu = phosphor(ListGlyph, "Menu");
export const Moon = phosphor(MoonGlyph, "Moon");
export const MoreHorizontal = phosphor(DotsThreeGlyph, "MoreHorizontal");
export const QuestionMark = phosphor(QuestionGlyph, "QuestionMark");
export const Search = phosphor(MagnifyingGlassGlyph, "Search");
export const Send = phosphor(PaperPlaneTiltGlyph, "Send");
export const Settings = phosphor(GearSixGlyph, "Settings");
export const ShieldCheck = phosphor(ShieldCheckGlyph, "ShieldCheck");
export const SlidersHorizontal = phosphor(SlidersHorizontalGlyph, "SlidersHorizontal");
export const Sun = phosphor(SunGlyph, "Sun");
export const UserRound = phosphor(UserGlyph, "UserRound");
export const UserCircle = phosphor(UserCircleGlyph, "UserCircle");
export const X = phosphor(XGlyph, "X");

/*
 * The primitives layer. `src/components/ui/*` is vendored shadcn, and every one of those files
 * shipped with a lucide import; these are the equivalents it needs so the whole console draws
 * from one set at one weight. Names follow the lucide identifier the primitive already used, so
 * the swap is a change of import path and nothing else -- a reader of `select.tsx` still sees a
 * `<ChevronUp />` where a chevron-up belongs.
 */
export const ArrowLeft = phosphor(ArrowLeftGlyph, "ArrowLeft");
export const ArrowRight = phosphor(ArrowRightGlyph, "ArrowRight");
export const ChevronUp = phosphor(CaretUpGlyph, "ChevronUp");
export const Eye = phosphor(EyeGlyph, "Eye");
/** The sidebar toggle. Phosphor draws it as a panel with its left column filled, same idea. */
export const PanelLeft = phosphor(SidebarSimpleGlyph, "PanelLeft");
export const Refresh = phosphor(ArrowsClockwiseGlyph, "Refresh");
/** Toast severities. Warning is the triangle, WarningOctagon the stop sign -- sonner uses both. */
export const TriangleAlert = phosphor(WarningGlyph, "TriangleAlert");
export const OctagonAlert = phosphor(WarningOctagonGlyph, "OctagonAlert");
/** The one glyph that spins. Callers add the animation; the icon layer never animates by itself. */
export const Spinner = phosphor(CircleNotchGlyph, "Spinner");

/*
 * The file-kind glyphs behind the upload primitive's MIME switch. `FileArchive` is the packaged
 * application (exe, apk, deb) and `FileZip` the literal archive -- lucide collapsed the first into
 * a cog, which read as "settings" in a list of attachments.
 */
export const File = phosphor(FileGlyph, "File");
export const FileArchive = phosphor(FileArchiveGlyph, "FileArchive");
export const FileAudio = phosphor(FileAudioGlyph, "FileAudio");
export const FileCode = phosphor(FileCodeGlyph, "FileCode");
export const FileText = phosphor(FileTextGlyph, "FileText");
export const FileVideo = phosphor(FileVideoGlyph, "FileVideo");
export const FileZip = phosphor(FileZipGlyph, "FileZip");

/*
 * The surfaces outside the admin console -- the agent flow trace, Meet Your Agent, the consumer
 * preview, and onboarding -- which were the last lucide holdouts.
 */
export const CalendarClock = phosphor(CalendarDotsGlyph, "CalendarClock");
export const CalendarDays = phosphor(CalendarBlankGlyph, "CalendarDays");
export const Camera = phosphor(CameraGlyph, "Camera");
export const ChatText = phosphor(ChatTextGlyph, "ChatText");
export const Chats = phosphor(ChatsCircleGlyph, "Chats");
export const CircleDashed = phosphor(CircleDashedGlyph, "CircleDashed");
export const Flask = phosphor(FlaskGlyph, "Flask");
export const ShieldAlert = phosphor(ShieldWarningGlyph, "ShieldAlert");
export const Smartphone = phosphor(DeviceMobileGlyph, "Smartphone");
export const Sparkle = phosphor(SparkleGlyph, "Sparkle");

/* ---------------------------------------------------------------------------
   The six bespoke marks. 16px grid, 1.5 stroke, round caps, currentColor.
   ------------------------------------------------------------------------- */

const MARK_STROKE: SVGProps<SVGSVGElement> = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  strokeWidth: 1.5,
};

function markProps({ className, label, size = KIT_ICON_SIZE, ...rest }: KitIconProps) {
  return {
    "aria-hidden": label ? undefined : (true as const),
    "aria-label": label,
    className: cn("shrink-0", className),
    height: size,
    role: label ? ("img" as const) : undefined,
    viewBox: "0 0 16 16",
    width: size,
    ...MARK_STROKE,
    ...rest,
  };
}

/** SMS: a squared-off bubble with a tail, deliberately unlike the round chat glyph above. */
export function SmsMark(props: KitIconProps) {
  return (
    <svg {...markProps(props)}>
      <path d="M2.5 4.25A1.75 1.75 0 0 1 4.25 2.5h7.5a1.75 1.75 0 0 1 1.75 1.75v5a1.75 1.75 0 0 1-1.75 1.75H6.4L3.5 13.5v-2.5h-.25A.75.75 0 0 1 2.5 10.25Z" />
      <path d="M5.5 6.75h5M5.5 8.75h3" />
    </svg>
  );
}

/** Booked: the confirmation ring, not a calendar -- the calendar glyph means "a date", this means "it is held". */
export function BookedMark(props: KitIconProps) {
  return (
    <svg {...markProps(props)}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M5.5 8.25 7.25 10l3.25-3.75" />
    </svg>
  );
}

/**
 * Live: a filled centre broadcasting outward. `pulse` plays the ring once -- for the moment an
 * agent goes live, never as an ambient loop, which would turn every list into a strobe.
 */
export function LiveMark({ pulse = false, ...props }: KitIconProps & { pulse?: boolean }) {
  const reduced = useReducedMotion();

  return (
    <svg {...markProps(props)} data-slot="live-mark">
      <circle cx="8" cy="8" fill="currentColor" r="2.25" stroke="none" />
      <motion.circle
        animate={pulse && !reduced ? { opacity: [0.9, 0], r: [3.25, 7] } : { opacity: 1, r: 5.75 }}
        cx="8"
        cy="8"
        data-slot="live-mark-ring"
        r="5.75"
        transition={{ duration: reduced ? 0 : 0.5, ease: [0.22, 1, 0.36, 1] }}
      />
    </svg>
  );
}

/** Vetting: a ring only part-drawn, because the carrier has not finished looking at it yet. */
export function VettingMark(props: KitIconProps) {
  return (
    <svg {...markProps(props)}>
      <path d="M8 2.25a5.75 5.75 0 0 1 5.06 8.48" opacity="0.45" />
      <path d="M13.06 10.73A5.75 5.75 0 1 1 8 2.25" />
      <path d="M8 5.25V8l1.75 1.25" />
    </svg>
  );
}

/** Paused: the ring is whole -- nothing is broken, it is simply stopped. */
export function PausedMark(props: KitIconProps) {
  return (
    <svg {...markProps(props)}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M6.5 6v4M9.5 6v4" />
    </svg>
  );
}

/** Test data: a dashed ring, so a seeded row is legible as seeded from across the room. */
export function TestMark(props: KitIconProps) {
  return (
    <svg {...markProps(props)}>
      <circle cx="8" cy="8" r="5.75" strokeDasharray="2.4 2.2" />
      <circle cx="8" cy="8" fill="currentColor" r="1.5" stroke="none" />
    </svg>
  );
}

export type { KitIcon };

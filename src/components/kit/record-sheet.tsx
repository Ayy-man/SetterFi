"use client";

import { ExternalLink, X } from "@/components/kit/icons";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { CopyValue } from "@/components/kit/copy-value";
import { StateBadge, type StateBadgeProps } from "@/components/kit/state-badge";
import { TechnicalDetail, type TechnicalDetailItem } from "@/components/kit/technical-detail";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

type DataStateAction = {
  label: string;
  onClick?: () => void;
  href?: string;
};

/**
 * One row of the group's key/value grid.
 *
 * The key column is fixed, not content-sized, so three groups stacked down a drawer line their
 * values up on one edge instead of stepping in and out with the length of each label.
 */
export type RecordSheetField = {
  label: string;
  /**
   * The value. Leave it out (or pass `null`) and the row prints `absence` in italic faint words
   * instead -- "not connected", "no phone number on file". Never an em dash, and never 0: a zero
   * is a measurement, and a thing that was never set has not been measured.
   */
  value?: ReactNode;
  /** ids, phone numbers, keys: mono 12 with a copy affordance beside them. */
  mono?: boolean;
  /** What the copy button writes. Defaults to `value` when the value is a plain string. */
  copy?: string;
  /** Real words for what is missing. */
  absence?: string;
};

export type RecordSheetSection = {
  title: string;
  /** A mono aside on the group title's right -- "2 of 3", "4 channels". */
  aside?: string;
  /** The labelled key/value grid. Pass `body` instead for a group that is not a grid. */
  fields?: readonly RecordSheetField[];
  body?: ReactNode;
};

/** Who did a thing and when, for the drawer's audit line. */
export type RecordSheetAudit = { when: string; who: string };

export type RecordSheetTab = {
  id: string;
  label: string;
  sections: readonly RecordSheetSection[];
};

export type RecordSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: string;
  fullRecordHref?: string;
  /**
   * The drawer's width on desktop. `default` is the standard `--drawer-w`; `wide` is for a record
   * whose body is a working surface rather than a summary. Full width on mobile either way.
   */
  size?: "default" | "wide";
  /** The flat body. Pass `tabs` instead when the record has more than one view. */
  sections?: readonly RecordSheetSection[];
  tabs?: readonly RecordSheetTab[];
  /** The record's state, shown as a pill beside the identity. */
  state?: StateBadgeProps;
  /** Further states on the same row -- channel, plan, test-data. `state` leads the row. */
  states?: readonly StateBadgeProps[];
  technical?: readonly TechnicalDetailItem[];
  primaryAction?: DataStateAction;
  secondaryAction?: DataStateAction;
  destructive?: DataStateAction;
  /** Audit microcopy for the footer, e.g. AUDIT_ACTIONS[...].microcopy. */
  logged?: string;
  /**
   * The audit line. Both halves are named props rather than free-form footer content because
   * "who last touched this record, and when" is the question an auditor opens the drawer to
   * answer -- it is not decoration a screen gets to leave off when the layout feels crowded.
   */
  created?: RecordSheetAudit;
  lastChange?: RecordSheetAudit;
};

function keepFocusInside(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => {
    if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;

    const closedDetails = element.closest("details:not([open])");
    if (closedDetails && closedDetails.querySelector(":scope > summary") !== element) return false;

    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
  const first = focusable.at(0);
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function Action({
  action,
  variant = "default",
}: {
  action: DataStateAction;
  variant?: "default" | "outline";
}) {
  if (action.href) {
    return (
      <Button
        className="w-full sm:w-auto"
        nativeButton={false}
        onClick={action.onClick}
        render={<a href={action.href} />}
        variant={variant}
      >
        {action.label}
      </Button>
    );
  }

  return (
    <Button
      className="w-full sm:w-auto"
      disabled={!action.onClick}
      onClick={action.onClick}
      type="button"
      variant={variant}
    >
      {action.label}
    </Button>
  );
}

/**
 * The fixed key column. Wide enough for "Registration" at 11px and narrow enough to leave the
 * value the rest of a 480px drawer.
 */
const KEY_COLUMN_WIDTH = "104px";

const FIELD_GRID_STYLE = {
  "--rs-key-w": KEY_COLUMN_WIDTH,
  gridTemplateColumns: "var(--rs-key-w) minmax(0, 1fr)",
} as CSSProperties;

function Field({ field }: { field: RecordSheetField }) {
  const missing = field.value === undefined || field.value === null || field.value === "";
  const copyText = field.copy ?? (typeof field.value === "string" ? field.value : undefined);

  return (
    <>
      <dt
        className="t-label min-w-0 self-baseline [overflow-wrap:anywhere]"
        data-slot="record-sheet-key"
      >
        {field.label}
      </dt>
      <dd className="m-0 flex min-w-0 items-baseline gap-[var(--s-2)]" data-slot="record-sheet-value">
        {missing ? (
          <span className="t-faint italic" data-slot="record-sheet-absence">
            {field.absence ?? "not recorded"}
          </span>
        ) : (
          <>
            <span
              className={cn(
                "min-w-0 [overflow-wrap:anywhere]",
                // `.t-id` declares both `font-size: 12px` and `color: var(--muted)`, and it is
                // unlayered, so in the mono arm neither the meta size nor the ink colour applied.
                // Deliberate overrides; the non-mono arm carries no recipe and needs none.
                field.mono
                  ? "t-id text-[length:var(--t-mono-meta)]! text-[var(--ink)]!"
                  : "text-[length:var(--t-body)] text-[var(--ink)]",
              )}
            >
              {field.value}
            </span>
            {field.mono && copyText ? (
              <CopyValue className="self-center" label={field.label} value={copyText} />
            ) : null}
          </>
        )}
      </dd>
    </>
  );
}

function Sections({ sections }: { sections: readonly RecordSheetSection[] }) {
  return (
    <>
      {sections.map((section, index) => (
        <section
          className="flex flex-col gap-[var(--s-3)] border-b border-[var(--line)] py-[var(--s-4)] last:border-b-0"
          data-slot="record-sheet-section"
          key={`${section.title}:${index}`}
        >
          <div className="flex min-w-0 items-baseline justify-between gap-[var(--s-3)]">
            <h3 className="text-[length:var(--t-label)] leading-[var(--t-label-lh)] font-semibold tracking-[var(--t-label-tr)] text-[var(--muted)] uppercase">
              {section.title}
            </h3>
            {section.aside ? (
              <span className="t-mono-crumb shrink-0 tabular-nums" data-slot="record-sheet-aside">
                {section.aside}
              </span>
            ) : null}
          </div>
          {section.fields?.length ? (
            <dl
              className="grid min-w-0 gap-x-[var(--s-3)] gap-y-[var(--s-2)]"
              data-slot="record-sheet-fields"
              style={FIELD_GRID_STYLE}
            >
              {section.fields.map((field) => (
                <Field field={field} key={field.label} />
              ))}
            </dl>
          ) : null}
          {section.body ? (
            <div className="min-w-0 text-[length:var(--t-body)] text-[var(--body)]">
              {section.body}
            </div>
          ) : null}
        </section>
      ))}
    </>
  );
}

function DestructiveAction({ action }: { action: DataStateAction }) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  function confirmAction() {
    action.onClick?.();
    setConfirmOpen(false);
  }

  return (
    <div
      className="rounded-[var(--r-card)] border border-[var(--critical-line)] bg-[var(--critical-wash)] p-[var(--s-3)]"
      data-slot="record-sheet-danger"
    >
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogTrigger
          disabled={!action.href && !action.onClick}
          render={<Button variant="destructive" />}
        >
          {action.label}
        </AlertDialogTrigger>
        <AlertDialogContent className="!duration-[var(--duration-quick)] !ease-[var(--ease-out)]">
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm {action.label.toLocaleLowerCase()}</AlertDialogTitle>
            <AlertDialogDescription>
              Review this action before continuing. It may be difficult to reverse.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {action.href ? (
              <AlertDialogAction
                nativeButton={false}
                onClick={() => {
                  action.onClick?.();
                  setConfirmOpen(false);
                }}
                render={<a href={action.href} />}
                variant="destructive"
              >
                Confirm {action.label.toLocaleLowerCase()}
              </AlertDialogAction>
            ) : (
              <AlertDialogAction onClick={confirmAction} type="button" variant="destructive">
                Confirm {action.label.toLocaleLowerCase()}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function RecordSheet({
  open,
  onOpenChange,
  title,
  subtitle,
  fullRecordHref,
  size = "default",
  sections,
  tabs,
  state,
  states,
  technical,
  primaryAction,
  secondaryAction,
  destructive,
  logged,
  created,
  lastChange,
}: RecordSheetProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  const titleId = useId();
  const descriptionId = useId();
  // The lead state first, then whatever else is true of the record, on one row.
  const pills = [...(state ? [state] : []), ...(states ?? [])];

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onOpenChangeRef.current(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", closeOnEscape);
      previousFocus?.focus();
    };
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        aria-describedby={subtitle ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        // The sheet inherits the primitive's open/close asymmetry rather than flattening it back
        // to one duration: it arrives on --panel-open-dur and leaves on the shorter
        // --panel-close-dur, because a panel you have decided to dismiss should not make you
        // watch it go.
        className={cn(
          "!w-full !max-w-none !gap-0 !rounded-l-[var(--r-panel)] !border-l !border-[var(--line)] !bg-[var(--raised)] !text-[var(--body)] !shadow-[var(--shadow-drawer)] ![transition-property:transform,opacity] ![transition-timing-function:var(--ease-smooth-out)]",
          size === "wide" ? "sm:!w-[720px]" : "sm:!w-[var(--drawer-w)]",
        )}
        data-slot="record-sheet"
        finalFocus={false}
        initialFocus={false}
        onKeyDown={keepFocusInside}
        role="dialog"
        showCloseButton={false}
        side="right"
      >
        <SheetHeader className="!flex-row !items-start !gap-[var(--s-3)] !border-b !border-[var(--line)] !p-[var(--s-5)]">
          <div className="min-w-0 flex-1" data-slot="record-sheet-identity">
            <SheetTitle
              className="!text-[length:var(--t-section-title)] !font-[var(--t-section-title-w)] !leading-[var(--t-section-title-lh)] !tracking-[var(--t-section-title-tr)] !text-[var(--ink)]"
              id={titleId}
            >
              {title}
            </SheetTitle>
            {pills.length ? (
              <span
                className="mt-[var(--s-2)] flex flex-wrap items-center gap-[var(--s-2)]"
                data-slot="record-sheet-state"
              >
                {pills.map((pill, index) => (
                  <StateBadge key={`${pill.label}:${index}`} size="sm" {...pill} />
                ))}
              </span>
            ) : null}
            {subtitle ? (
              <SheetDescription
                className="!mt-[var(--s-1)] !text-[length:var(--t-body)] !text-[var(--muted)]"
                id={descriptionId}
              >
                {subtitle}
              </SheetDescription>
            ) : null}
          </div>
          {fullRecordHref ? (
            <a
              className="inline-flex shrink-0 items-center gap-[var(--s-1)] text-[length:var(--t-body)] font-medium text-[var(--accent-text)]"
              href={fullRecordHref}
            >
              Open full record
              <ExternalLink aria-hidden className="size-[var(--s-3)]" />
            </a>
          ) : null}
          <SheetClose
            render={
              <Button
                aria-label="Close"
                className="!size-[var(--s-8)] !rounded-[var(--r-control)]"
                ref={closeButtonRef}
                size="icon"
                variant="ghost"
              />
            }
          >
            <X aria-hidden className="!size-[var(--s-4)]" />
          </SheetClose>
        </SheetHeader>

        <div
          className="relative min-h-0 flex-1 overflow-y-auto px-[var(--s-5)] pt-[var(--s-2)] pb-[var(--s-5)]"
          data-slot="record-sheet-sections"
        >
          {tabs?.length ? (
            <Tabs defaultValue={tabs[0]?.id}>
              <TabsList className="w-full" variant="line">
                {tabs.map((tab) => (
                  <TabsTrigger key={tab.id} value={tab.id}>
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {tabs.map((tab) => (
                <TabsContent key={tab.id} value={tab.id}>
                  <Sections sections={tab.sections} />
                </TabsContent>
              ))}
            </Tabs>
          ) : (
            <Sections sections={sections ?? []} />
          )}
        </div>

        <SheetFooter className="sticky bottom-0 !mt-0 !gap-[var(--s-3)] !border-t !border-[var(--line)] !bg-[var(--raised)] !p-[var(--s-3)] sm:!px-[var(--s-5)]">
          {primaryAction || secondaryAction ? (
            <div
              className="flex flex-wrap justify-end gap-[var(--s-2)]"
              data-slot="record-sheet-primary-action"
            >
              {secondaryAction ? <Action action={secondaryAction} variant="outline" /> : null}
              {primaryAction ? <Action action={primaryAction} /> : null}
            </div>
          ) : null}
          {logged ? (
            <p
              className="m-0 text-[length:var(--t-badge)] text-[var(--faint)]"
              data-slot="record-sheet-logged"
            >
              {logged}
            </p>
          ) : null}
          {technical?.length ? <TechnicalDetail items={technical} /> : null}
          {created || lastChange ? (
            <p
              className="t-mono-crumb m-0 flex w-full flex-wrap items-baseline justify-between gap-x-[var(--s-3)] gap-y-[var(--s-1)]"
              data-slot="record-sheet-audit"
            >
              <span data-slot="record-sheet-created">
                {created ? `created ${created.when} \u00b7 ${created.who}` : null}
              </span>
              <span data-slot="record-sheet-last-change">
                {lastChange ? `last change ${lastChange.when} \u00b7 ${lastChange.who}` : null}
              </span>
            </p>
          ) : null}
          {destructive ? <DestructiveAction action={destructive} /> : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

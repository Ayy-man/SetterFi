"use client";

import Link from "next/link";

import { LoggedButton } from "@/components/kit/logged-button";
import { Button, buttonVariants } from "@/components/ui/button";
import type { AuditActionKey } from "@/lib/audit/actions";

export type PrimaryAction = {
  label: string;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  /** Audit-logged actions render as a LoggedButton, so the caption sits under the button. */
  logged?: AuditActionKey;
};

/**
 * The one filled control on a page.
 *
 * Every other header control is an outline or ghost button, so this is the only place the accent
 * fill appears above the content -- which is what makes it readable as "the thing this page wants
 * you to do". A page with nothing to ask for passes nothing and gets no fill.
 */
export function PrimaryActionButton({ action }: { action: PrimaryAction }) {
  if (action.logged) {
    return (
      <LoggedButton
        actionKey={action.logged}
        disabled={action.disabled}
        onClick={action.onClick}
        variant="primary"
        wrapperClassName="items-end"
      >
        {action.label}
      </LoggedButton>
    );
  }

  // A link stays a link: an anchor styled with the button's own variants, rather than a Button
  // rendering an anchor, which either stamps type="button" on it or announces it as a button.
  if (action.href) {
    return (
      <Link
        className={buttonVariants()}
        data-variant="primary"
        href={action.href}
        onClick={action.onClick}
      >
        {action.label}
      </Link>
    );
  }

  return (
    <Button data-variant="primary" disabled={action.disabled} onClick={action.onClick}>
      {action.label}
    </Button>
  );
}

/**
 * Where a coach's links may point.
 *
 * Links are the only way an agent shares a file: nothing in the send path carries an attachment,
 * every channel accepts a URL in text, and a link the agent sends has to pass the same host
 * check the compliance rule LINK-001 applies to generated replies. So the rule is stated once,
 * here, and enforced twice: at save (`validateCoachOfferDraft` and `save_offer_draft`) and at
 * send (`output-checks.ts`).
 *
 * The tenant's own whitelist in `tenant_settings.link_whitelist` is platform-owned and usually
 * empty, which used to mean every link a coach pasted was refused with nothing they could do
 * about it. These hosts are allowed for every tenant, and so is the host of the website they
 * gave in their business profile. `app.offer_asset_allowed_hosts` holds the same list on the
 * database side; change both or neither.
 */
export const DEFAULT_ASSET_HOSTS: readonly string[] = Object.freeze([
  "drive.google.com",
  "docs.google.com",
  "dropbox.com",
  "notion.site",
  "loom.com",
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "calendly.com",
]);

/** The one sentence the editor states the rule in, so a refusal never reads as a bug. */
export const ASSET_LINK_RULE =
  "A public https link to a PDF or page on your own website, Google Drive, Dropbox, Notion, Loom, "
  + "YouTube, Vimeo or Calendly. Files cannot be uploaded here; host the file and paste its link.";

/** The host of a URL, lowercased, or null when it is not a URL. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Every host a tenant may link to: the platform's list, the tenant's own, and their website. */
export function assetHostsFor(
  tenantWhitelist: readonly string[],
  websiteUrl: string | null | undefined,
): string[] {
  const website = hostOf(websiteUrl);
  return [...new Set([
    ...DEFAULT_ASSET_HOSTS,
    ...tenantWhitelist.map((host) => host.trim().toLowerCase()).filter(Boolean),
    ...(website ? [website] : []),
  ])];
}

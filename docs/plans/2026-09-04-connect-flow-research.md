# Connect flow research: how real products let you connect an account

Date: 2026-09-04
Researcher: mobbin-research agent
Source: Mobbin (web flows and screens), searched 2026-09-04
Audience for the outcome: SetterFi coaches, typically over 55, non-technical, connecting Instagram
and Facebook Messenger through Meta OAuth, plus a calendar and text messaging.

The screen in question today is a button labelled "Connect Instagram and Messenger" that navigates
to another page where nothing happens. The target is an in-place sheet or modal that explains what
will happen, lists the permissions, runs the OAuth in a popup or redirect, and returns to a clear
connected or failed state without the coach losing their place.

---

## Part 1: The flows

Fourteen distinct real product flows, all web unless noted. Every one was inspected as an image, not
just read from metadata.

### 1. Cofounder, connecting a social account from a composer
https://mobbin.com/flows/7897406d-dd60-4afa-94ad-65a9468c1d64

**Steps.** A modal titled "Where should this post go?" sits over the working canvas with a progress
bar across its top. Under the uploaded file it shows a row of channel chips, LinkedIn, Instagram, X,
Facebook, Reddit, TikTok, each with a small unfilled dot to its left meaning not connected. Picking
one opens the provider's own consent page. Instagram's page says "You previously connected Social
Media Connector to your instagram account. Would you like to continue sharing information about
slmobbin to Social Media Connector?" with Allow and Cancel stacked, and small print explaining that
Instagram will record when the app accesses the data. Back in Cofounder, the canvas is still exactly
where it was and a toast in the bottom left says "Finish connecting in the popup."

**Where it lives.** Modal over the working page, provider consent in a popup window.

**Permissions.** Deferred entirely to the provider's consent page. Cofounder itself explains nothing.

**Success.** The chip's dot fills in and the Next button becomes enabled.

**Failure or cancel.** The popup closes and the modal is still there, unchanged, chip still unfilled.

**Getting back.** The user never left. The canvas behind the modal is untouched.

**Worth stealing.** The "Finish connecting in the popup" toast. It is the single best answer to the
question a 55-plus user asks when a second window steals focus, which is "what just happened and
what do I do now."

### 2. Etsy, connecting social accounts from Shop Manager
https://mobbin.com/flows/d79e91d5-afb6-4d47-a5c2-3e20fc0e82fe

**Steps.** From the Social media page a gear opens a "Social account settings" modal listing four
providers as rows: Facebook with a paragraph of explanation, Pinterest showing "We're working on
restoring access to Pinterest" and no button at all, Twitter showing "Disconnect" because it is
already connected, and Instagram with a caveat that you also need the Sell on Etsy phone app.
Choosing Facebook goes to the provider's authorize page, a full page headed "Authorize Etsy to
access your account?" with a long bulleted list of capabilities.

**Where it lives.** Modal for the list, full page redirect for consent.

**Permissions.** The provider's page carries the whole list, ten bullets deep, split into what the
app can do. Etsy adds a one-line plain summary per provider in its own modal.

**Success.** The row flips to showing "Disconnect" and the connected handle.

**Failure.** Not shown, but Cancel sits next to Authorize app on the provider page.

**Getting back.** Redirect returns to the Social media page.

**Worth stealing.** Three different row states in one list, connectable, connected, and unavailable,
each rendered as a different affordance. Pinterest gets prose instead of a button, which is exactly
the shape SetterFi needs while Meta approval is pending.

### 3. Semrush, connecting Facebook to Social Poster
https://mobbin.com/flows/dac5df84-a65d-4d88-9db2-f6f6936eead0

**Steps.** An intent question first, "What would you like to do first?" with three illustrated
cards. Then the connect step, then a centred success card with a small illustration reading
"1 profile successfully connected" and the subline "You can now schedule posts, reply to messages,
and explore statistics for these profiles." Primary button Continue, secondary text link
"Connect more profiles". Then the actual product, the Social Poster calendar.

**Where it lives.** Full-page steps inside an onboarding wizard.

**Permissions.** Not surfaced in Semrush's own chrome.

**Success.** A dedicated full screen. The count is stated as a number, "1 profile", and the copy
names the three things now possible.

**Failure.** Not captured.

**Getting back.** Continue lands on the feature the connection unlocks, not back to settings.

**Worth stealing.** The success copy names the capability rather than the mechanism. Not "OAuth
token stored" but "you can now schedule posts, reply to messages". That framing is the single most
transferable thing here for a non-technical audience.

### 4. HubSpot, the permission detail pattern on X
https://mobbin.com/flows/e882dfd7-7c1f-47c2-9911-a68644880aee

**Steps.** The consent page leads with the app logo, then "HubSpot wants to access your X account.",
then the identity of the logged-in account with avatar and handle, then Authorize app as a solid
button with Cancel in red text below it. Only below that fold does the permission detail appear,
split into two labelled groups, "Things this App can do..." and "Things this App can view...", each
showing three bullets and a "3 more" link.

**Where it lives.** Full page.

**Permissions.** Progressive disclosure. Three bullets visible per group, the rest behind "3 more".

**Success and failure.** Not captured in this two-screen flow.

**Worth stealing.** Two things. First, showing which account you are about to connect, with the
avatar and handle, before you approve. Second, capping the visible permission list at three per
group and hiding the tail behind a link. A coach will not read eleven bullets, but will read three.

### 5. Pinterest, claiming an Instagram account
https://mobbin.com/flows/2f724918-86b5-4c65-9168-265a71f4a942

**Steps.** A settings page called "Link to Pinterest" lists Instagram, Websites and MikMak as rows,
each with a one-sentence benefit and a "Claim" button. After the provider handshake a celebratory
modal appears, "Congrats! Your Pinterest is connected to @slmobbin", and it does configuration in
the same breath: a board name field and a radio group for how far back to import, 90, 180, 365 days
or None, with the note "Content is generally imported within 2-5 days." One Done button. Behind it
the settings row now reads "Connected to @slmobbin" with an inline "Account settings" panel and an
Unclaim button, and a dark toast confirms "Instagram account is successfully claimed, auto-publish
is enabled."

**Where it lives.** Settings page with modal for both consent aftermath and configuration.

**Permissions.** Stated as consequences rather than scopes. "Private Instagram posts will be visible
to everyone, including non-Pinners, when auto-published."

**Success.** Three simultaneous signals: the modal, the changed row, and the toast.

**Failure.** Not captured.

**Getting back.** Done returns to the same settings page, scrolled to the same place.

**Worth stealing.** Consequence language over scope language, and the decision to ask the one
configuration question at the moment of success rather than before consent.

### 6. Amie, connecting Spotify from an integrations sheet
https://mobbin.com/flows/a4d27160-382a-42ff-ac01-a23e28edc9a2

**Steps.** A settings overlay with its own left rail. The Integrations pane lists apps as rows with
icon, name, and a one-line purpose, "Visualize listened songs on your calendar". Apple Reminders
carries a grey "Soon" pill instead of being actionable. Choosing Spotify opens Spotify's consent
page, which groups permissions under three icons: view your account data, view your activity, take
actions on your behalf, each with sub-bullets, plus the line "You can remove this access at any time
at spotify.com/account." Agree is a big green pill, Cancel is a plain text link below it. Back in
Amie the list now has a "Connected" section at the top holding Spotify with an overflow menu, and a
small toast bottom right says "Spotify Integration enabled".

**Where it lives.** Settings overlay, escape key labelled on the close button.

**Permissions.** Three verb-led groups on the provider side.

**Success.** The item moves out of the Apps list into a Connected section. That physical relocation
is a stronger signal than a badge.

**Failure.** Not captured.

**Getting back.** The overlay is still open at the same pane.

**Worth stealing.** Promoting connected items into their own section at the top, and the "Soon" pill
for what is not ready yet.

### 7. Notion, connecting a third-party integration inside a document
https://mobbin.com/flows/473e4bc1-9512-483d-b5d7-34839f1cca40

**Steps.** From the page overflow menu, "Connect to" opens a searchable submenu of connectors,
Bardeen, Census, Hightouch, IFTTT, Make and so on, with "Manage connections" pinned at the bottom.
Choosing one raises a small centred confirm dialog: "Bardeen is developed by a third party partner
and you will be redirected outside of Notion to authorize this connection. Continue?" with Confirm
in red text and Cancel below.

**Where it lives.** Menu, then a small confirm modal, then an external redirect.

**Permissions.** None yet. This step only warns about leaving.

**Worth stealing.** The explicit interstitial that says you are about to leave and who you are about
to deal with. For a 55-plus user, an unannounced jump to a Facebook-branded page is the moment they
stop and phone support.

### 8. Notion, connecting Notion MCP to ChatGPT
https://mobbin.com/flows/7ebf1f4f-6b89-4d52-805f-7d201d4a8e8e

**Steps.** A Connections settings modal offering cards to discover connectors. The consent card is
the interesting screen: "Connect with Notion MCP", subtitle "Grant chatgpt.com access to Notion",
a workspace picker showing "samlee's Space, Business Trial, 1 member", then four ticked lines of
what the other side will be able to do, then a yellow warning block reading "You will be redirected
to the following location:" with the full URL printed, and a checkbox "I recognize and trust this
URL". Continue stays disabled until that box is ticked. Cancel below. Success is a green banner at
the top of ChatGPT, "Notion is now connected", plus a detail panel showing Connected on Apr 16, 2026
and a Disconnect button.

**Where it lives.** Modal inside settings.

**Permissions.** Four ticked plain-language lines.

**Success.** Green top banner plus a permanent detail panel with the connection date.

**Worth stealing.** Recording and displaying the date the connection was made. It answers "is this
still working" without any extra machinery. The URL checkbox is right for a developer audience and
wrong for coaches, so leave that one.

### 9. Slack, adding an app from the App Directory
https://mobbin.com/flows/c5d75e81-184d-4af0-bb46-5272179e6100

**Steps.** A directory listing page with a large "Add to Slack" button and tabs for Description,
Features, Permissions, Security & Compliance. The consent page is headed "Allow the 'Notion AI' app
to access Slack" and carries a green reassurance line, "App is approved by Slack", plus "Apps are
reviewed for quality before they are listed in the Slack Marketplace." A workspace picker sits under
that. On the right, "Review app permissions" is a set of four collapsed accordion rows split into
information it can view and actions it can take, with "More permissions" below. Cancel and Allow are
bottom right. Afterwards the app appears in the sidebar under Apps with its own home tab.

**Where it lives.** Full page.

**Permissions.** Collapsed accordions, expandable, split view versus act.

**Success.** The app becomes a persistent item in the sidebar.

**Worth stealing.** The trust line. "App is approved by Slack" does more work for a nervous user
than any permission list. SetterFi's equivalent is naming Meta as the party doing the checking.

### 10. Google Gemini, connecting Google Workspace
https://mobbin.com/flows/7689b658-0dcd-4582-b0f7-19c443c73602

**Steps.** A Connected Apps page of cards, each with an icon, a name, a description and a toggle at
the top right. Flipping the Google Workspace toggle raises a modal, "Connect Google Workspace to
Gemini?", showing the account chip alexsmith.mobbin@gmail.com underneath, then three bullets under
"Your data from Google Workspace and your Google Account is used to:", then a "Things to know"
section and a "You're in control" section explaining how to change it later. Cancel and Connect
bottom right. On confirm the toggle turns blue and stays blue.

**Where it lives.** Modal over the settings page. No navigation at all.

**Permissions.** Three plain bullets, then two labelled reassurance blocks.

**Success.** The toggle state. Nothing else changes.

**Failure.** Cancel simply leaves the toggle off.

**Worth stealing.** The toggle as both the trigger and the state. One control, two jobs, and it
never lies about where you are. Also the "You're in control" block, which pre-answers the "can I
undo this" question that stops older users from clicking.

### 11. Quicken Simplifi, adding a financial institution
https://mobbin.com/flows/8e619657-3463-4d54-bddc-07eac6577793

**Steps.** An "Add account" modal with a search field and a grid of popular institutions, plus two
escape hatches at the bottom, "Track assets" and "Add manual account". Choosing one swaps the modal
content, keeping the same frame and adding a back arrow to its top left. The next panel shows the
two logos joined by arrows and reads "Quicken Simplifi uses Intuit to connect", then "We need your
consent to access your data", then three collapsed rows: "Data that's accessed", "Your data is kept
private", "You're in control". The third panel is instructional rather than legal: "Authorization
access required", with three imperative bullets, "Sign in to Robinhood through the secure browsing
window", "When prompted, SELECT ALL YOUR ACCOUNTS", "You'll be able to hide accounts in Quicken
after a secure connection is established." Sign in bottom right.

**Where it lives.** One modal frame, content swapping in place, back arrow throughout.

**Permissions.** Three collapsed disclosure rows, opened only if wanted.

**Worth stealing.** Two patterns. The rehearsal screen that tells you what you will see in the
popup and what to click when you get there is the strongest single idea in this whole survey for a
55-plus audience. And the modal that swaps content while keeping its frame and back arrow means the
user's sense of place is never broken.

### 12. Monarch, connecting a bank account
https://mobbin.com/flows/60449d28-6d92-4d15-8f92-81a1e98f2c3e

**Steps.** A dashboard checklist widget, "Jane, let's finish setting up your account", with
"Add an account" as step one. Choosing it opens the Plaid-branded modal, "Monarch uses Plaid to
connect your accounts", two icon bullets, "Connect effortlessly" and "Your data belongs to you",
privacy line, one Continue button. Then Plaid's own step, "Log in at Wise", subtitle "You'll be sent
to Wise to securely log in to your account", button "Continue to login" with an external-link glyph.
Then the provider's waiting state, a full page reading "We're waiting for your response", subtext
"Approve this login by opening the Wise app and tapping 'Yes, it's me'", a spinner, and beneath it a
quiet link "I haven't received an approval request". On return the dashboard checklist has "Add an
account" struck through with a green tick and the transaction list has filled with real rows.
Separately, when a connector struggles, Monarch offers a "Try other connections" modal: "Monarch
works with multiple account connectors. We always offer the best connection first based on success
rate but you can try another connector at anytime", listing Plaid tagged BEST CHOICE, then Finicity,
then MX, then "Add manual account".

**Where it lives.** Modal throughout, with an external-link glyph marking the one step that leaves.

**Success.** The originating checklist item ticks off and the empty dashboard fills with data.

**Failure.** A named fallback ladder rather than a dead end, and an explicit "I haven't received an
approval request" escape from the waiting state.

**Worth stealing.** The escape hatch inside the waiting state. Every connect flow has a moment where
the user is staring at a spinner wondering whether it is their fault, and a link there is cheap
insurance. Also the completion of the originating checklist item, which closes the loop visibly.

### 13. Rocket Money and Origin, connect during onboarding
https://mobbin.com/flows/112ac3e9-1d6b-4481-91bb-de4bea72e8ec and
https://mobbin.com/flows/c474c2a4-3cec-420c-ae05-7ce1a835014f

**Steps.** Rocket Money puts a stepper across the top, Choose your goals, Link your accounts, Become
a member, Download the app, so the connect step is visibly one of four. The left half sells the
benefit, "Let's find your subscriptions", with a "Bank-level 256-bit encryption" pill and a rotating
social-proof line, "Jordan just saved $14.95 per month by cancelling Audible." The right half is the
actual work, rows for Checking and Credit Cards each with an Add button, and Continue below.
Connected rows gain a tick and a count, "Wise (US), 1 Account". Origin's version ends on a named
success page, "Nice work, Sam. You've successfully linked Wise (US)", with the account listed, a
"Link another account" secondary button, a Continue primary, and a separate toast top right, "Your
account is now connected. All data will automatically refresh within the next few minutes."

**Where it lives.** Full page during onboarding, modal for the provider handshake.

**Success.** Named, personal, and specific about what happens next and when.

**Worth stealing.** Splitting the screen so the reassurance lives on one side and the checklist of
things to connect lives on the other, with Continue always available. And Origin's success line,
which sets an expectation about timing rather than implying everything is instant.

### 14. Bonsai, connecting a bank account from an empty state
https://mobbin.com/flows/8d87bc19-fa71-4f60-97d4-518e82984c14

**Steps.** A marketing-style empty state with an illustration and two buttons, "Connect Bank Account"
primary and "Add Expense Manually" secondary. Choosing connect gives a quieter interstitial page
with a bank glyph and the line "Connect a credit card or bank account to automate your expense
tracking", plus an info panel below: "You expenses will be automatically imported and categorized...
Depending on your bank, new expenses can take anywhere from a few minutes up to 2-3 days to appear
in your account." Then the Plaid modal, "Share your account data with Bonsai using Plaid", two
bullets, "Share your data securely" and "You're always in control", Continue.

**Worth stealing.** Stating the honest latency up front. Nothing damages trust with a non-technical
user faster than a success screen followed by an empty inbox with no explanation.

---

## Supporting screens: failure and not-yet states

**Failure and re-auth.**

- Klaviyo shows an "Action Required" tag next to the integration name in the breadcrumb, a red
  panel reading "Your credentials have expired. Please re-authenticate with Shopify to resume
  syncing.", a sentence explaining what happens after you authorise, and a
  "Re-Authenticate with Shopify" button.
  https://mobbin.com/screens/d093ed4b-a5c5-464e-8e65-4628ef3939a3
- Typeform's failure screen keeps the three-step progress rail visible at the bottom with step three
  highlighted, so you can see where it broke, and offers both Retry and Start over.
  https://mobbin.com/screens/5794c9e8-ca65-40a4-b2d3-8ed618245921
- ElevenLabs puts the failure inside the same configure modal, a red block reading
  "Connection failed. Connection failed: HTTP 401 Unauthorized", with the fields still filled and
  Back and Connect still in place.
  https://mobbin.com/screens/e37ce067-3ae6-4212-81b0-5d65968f8fa5
- Steep prints the raw error in a monospace box under "Connection failed. We got the following
  error when trying to connect to your data source", with a Retry button and a help-centre link.
  Right for developers, too much for coaches.
  https://mobbin.com/screens/c70f80de-5c92-4044-b3b5-b44b819647b9
- 1Password shows a "Not Connected" chip against the provider logo, a "Misconfigured Configured
  Identity Provider" panel naming the specific missing field, a "Test connection" button, and a
  "Save and Configure Later" secondary so you can leave without losing work.
  https://mobbin.com/screens/f88f849b-69f5-489e-8cfc-77b8f2900f48

The common shape: the error stays inside the frame the user was already in, it names the provider,
it says what to do next as a verb, and the primary action is retry rather than dismiss.

**Not available yet.**

- Ditto has a literal "Coming Soon" section heading below its live Connections grid, with the line
  "These integrations are currently in progress... we'll keep you posted on progress!" Each card in
  that section has a "Notify Me" button where the live ones have "Open".
  https://mobbin.com/screens/85c96adc-5a9d-49c5-b2f1-6fec41b03c52
- TheyDo uses a disabled grey "Coming soon" button in the same column where live rows have "Enable",
  sometimes paired with an "Early Access" tag, and closes the list with a prompt asking which
  integration you would like.
  https://mobbin.com/screens/f598f6b4-e64e-450e-a1c3-fcf88232b9dd
- Fabric uses an "Available soon" pill in place of the action button.
  https://mobbin.com/screens/f8829345-648e-4047-92f5-25f8cd389621
- Zendesk covers the in-progress case rather than the unavailable one: "Hang on tight. We're
  launching your Zendesk Explore account. It may take a couple of hours depending on the number of
  tickets in your Zendesk Support account", with a "Notify me when Explore is ready" toggle already
  switched on and a link to read the guide meanwhile.
  https://mobbin.com/screens/94bcd14c-d56f-433a-9f14-e9708a1a7b8a
- Walmart's out-of-area page is the warmest version: a plain headline stating the fact, then a card
  asking "Want to stay updated when InHome comes to your area?" with the email prefilled and a
  Notify Me button, then a second card pointing at what is available now.
  https://mobbin.com/screens/136bd111-468d-4942-acd6-970f193a8033
- Airbnb's is the shortest: "No co-hosts nearby. Sign up to be notified if one becomes available."
  and a single Notify me button.
  https://mobbin.com/screens/3c1e8fda-8cf0-4915-8cce-76fe2d369fa6
- Etsy's Pinterest row, described in flow 2, replaces the button with a sentence, "We're working on
  restoring access to Pinterest", which is the most honest handling of a temporary outage.

---

## Part 2: The patterns that recur

**1. The connect action never navigates away from where it was pressed.** Every good flow here
either opens a modal over the current page (Gemini, Quicken, Monarch, Bonsai, Amie, Etsy) or opens
the provider in a popup while the origin page stays put (Cofounder). The only full-page redirects
are on the provider's own domain, which is a place users recognise. The failure mode SetterFi has
today, a button that navigates to a page where nothing happens, is precisely the thing none of these
products do. Suits 55-plus: strongly. Losing your place is the single most disorienting thing that
can happen to someone who is not confident they can find their way back.

**2. Permissions are stated as capabilities and consequences, never as scopes.** Spotify says "Take
actions in Spotify on your behalf". Gemini says what your data is used to do. Pinterest says
"Private Instagram posts will be visible to everyone". Nobody writes instagram_basic or
pages_messaging. The best lists cap at three or four bullets with the tail behind a "more" link
(HubSpot, Slack). Suits 55-plus: strongly, provided the list is short. Eleven bullets gets skipped
by everyone and frightens the cautious.

**3. There is a rehearsal step before the handover.** Quicken's "Authorization access required"
screen tells you what the popup will look like and what to click in it. Monarch's "Continue to
login" marks the external jump with a glyph. Notion's confirm dialog says outright that you are
about to be redirected outside and names the third party. Cofounder's toast says "Finish connecting
in the popup". Suits 55-plus: this is the highest-value pattern in the survey. The moment a
Facebook-branded window appears unannounced is the moment a non-technical user assumes something
has gone wrong.

**4. The user is shown which account they are about to connect.** HubSpot shows the avatar and
handle. Gemini shows the email chip. Slack and Notion show a workspace picker. This matters doubly
for Meta, where a coach may have a personal profile, a business page, and an Instagram account all
tangled together, and connecting the wrong one produces a silent failure later. Suits 55-plus:
strongly.

**5. Success is stated in terms of what now works, not what was stored.** Semrush: "You can now
schedule posts, reply to messages, and explore statistics." Origin: "All data will automatically
refresh within the next few minutes." Bonsai warns that expenses can take two to three days. Success
states also give the connection a permanent home: a Connected section (Amie), a filled toggle
(Gemini), a connection date (ChatGPT), a struck-through checklist item (Monarch). Suits 55-plus:
strongly, especially the honest timing.

**6. Errors stay in the frame, name the provider, and lead with a verb.** Klaviyo:
"Re-Authenticate with Shopify". Typeform: Retry and Start over side by side with the progress rail
still showing. ElevenLabs keeps the form filled behind the red block. Nobody makes you start from
the beginning of the site. Suits 55-plus: yes, if the message avoids raw error strings. Steep's
monospace ENOTFOUND box is the counter-example to avoid.

**7. Not-yet states swap the button, they do not hide the row.** Ditto, TheyDo and Fabric all keep
the unavailable integration visible with a "Coming soon" or "Notify me" affordance in place of the
action. Etsy replaces the button with a plain sentence. Zendesk pre-arms a notify toggle and points
at something useful to read meanwhile. Suits 55-plus: yes. A row that vanishes reads as a bug or as
something the user did wrong; a row that says "not ready yet, we will tell you" reads as normal.

---

## Part 3: Recommended sequence for the SetterFi connect sheet

A side sheet, opened from the existing button, four states in one frame. Not four pages. The sheet
keeps a back arrow and a close button throughout, and closing at any point returns the coach to the
integrations page scrolled exactly where they were.

**State 1: What this does.** Title "Connect Instagram and Messenger". One sentence of purpose, then
a short list of what SetterFi will be able to do, three items maximum, then what it will never do.
Primary button "Continue". A quiet "Not now" text link below it.

Copy:

> **Connect Instagram and Messenger**
>
> Your assistant will read new messages from your Instagram and Facebook pages, and reply to them
> for you.
>
> To do that, Facebook will ask you to give SetterFi permission to:
> - Read messages people send to your Instagram account
> - Read messages people send to your Facebook page
> - Send replies on your behalf
>
> Your assistant will never post to your feed, change your profile, or see your personal messages.
>
> [ Continue ]   Not now

**State 2: What happens next.** The rehearsal step, borrowed from Quicken. This is the screen that
prevents the support call.

> **Facebook will open in a new window**
>
> 1. Sign in to Facebook if it asks you to.
> 2. Choose the Facebook page your business uses.
> 3. Leave all the boxes ticked and press Continue.
>
> When you are done, this window will update on its own. It usually takes about a minute.
>
> [ Open Facebook ]   Back

**State 3: Waiting.** The sheet stays open behind the popup with a spinner and a line naming the
window to look for, plus the escape hatch Monarch uses.

> **Waiting for Facebook**
>
> Finish signing in on the Facebook window. This window will update when you are done.
>
> The Facebook window did not open

That last line reopens the popup and, on a second failure, explains pop-up blockers in one sentence
with a link.

**State 4a: Connected.** Named, specific, capability-led, with the timing stated honestly.

> **Instagram and Messenger are connected**
>
> Connected to Coastal Strength Coaching on 4 September 2026.
>
> Your assistant will start answering new messages straight away. Messages sent before now will not
> be answered.
>
> [ Done ]   See your messages

Behind the sheet the integrations row flips to a connected state with the page name, the date, and a
Disconnect action, and the onboarding checklist item ticks off.

**State 4b: Something went wrong.** In the same frame, with the provider named and a verb as the
primary action.

> **Facebook did not finish connecting**
>
> Nothing was changed. This usually means the window was closed early, or the page you chose is not
> a business page.
>
> [ Try again ]   Get help

Never print a raw error string. If a support code is needed, put it in small grey text at the
bottom as "Reference: ABC123" so a coach can read it down the phone.

**State 4c: Cancelled.** Not an error. Return to state 1 with a quiet line at the top, "You closed
the Facebook window before finishing. Nothing was changed."

**The not-yet-approved variant.** Where Meta approval is still pending on a deployment, the row
stays visible and the sheet opens in an informational state with no OAuth trigger at all.

> **Instagram and Messenger are not ready yet**
>
> Facebook is still reviewing SetterFi's application. We will email you the day it is ready, and
> you will be able to connect from this same page.
>
> In the meantime, your assistant can answer text messages. [ Set up text messaging ]
>
> [ Email me when it is ready ]

Pre-tick the notify preference the way Zendesk does, and follow Walmart's lead by pointing at what
does work today rather than leaving the coach at a dead end.

---

## Copy tone rules for this sheet

Sentence case for every heading and button. No title case, it reads as marketing.

Say Facebook and Instagram, never Meta, never OAuth, never authorise, never scopes, never tokens,
never integration. The coach knows what Facebook is. Use "connect", "sign in", "give permission",
"window".

Every button is a verb the coach would say out loud: Continue, Open Facebook, Try again, Done.
Never Submit, never OK, never Authorize.

Say what the assistant will do and what it will not do, in that order, in the same breath. The
negative half is what earns the click.

Write dates in full, "4 September 2026", not "04/09/26". Write durations concretely, "about a
minute", not "shortly".

One idea per line. Where the survey showed long paragraphs of legal text, they were on the
provider's page, not the product's, and SetterFi should keep it that way.

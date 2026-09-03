export type AdminFeedbackTone = "neutral" | "good" | "pending" | "bad";

export type AdminLeaderboardRow = {
  id: string;
  client: string;
  leads: number;
  qualified: number;
  booked: number;
  bookingConversion: number;
  timeToBookHours: number;
  tier: "Launch" | "Scale" | "Pro";
  tierRank: number;
  margin: number;
  /** Booked calls per week for the last six weeks. Each series sums to `booked`. */
  trend: number[];
};

export const adminFeedbackLeaderboard: AdminLeaderboardRow[] = [
  {
    id: "client-elevate",
    client: "Elevate Credit Co",
    leads: 412,
    qualified: 171,
    booked: 84,
    bookingConversion: 49.1,
    timeToBookHours: 50.4,
    tier: "Pro",
    tierRank: 3,
    margin: 82,
    trend: [11, 12, 13, 14, 16, 18],
  },
  {
    id: "client-northgate",
    client: "Northgate Funding",
    leads: 350,
    qualified: 147,
    booked: 68,
    bookingConversion: 46.3,
    timeToBookHours: 67.2,
    tier: "Scale",
    tierRank: 2,
    margin: 86,
    trend: [9, 10, 11, 12, 13, 13],
  },
  {
    id: "client-apex",
    client: "Apex Capital Coaching",
    leads: 288,
    qualified: 106,
    booked: 41,
    bookingConversion: 38.7,
    timeToBookHours: 81.6,
    tier: "Scale",
    tierRank: 2,
    margin: 88,
    trend: [8, 8, 7, 6, 6, 6],
  },
  {
    id: "client-meridian",
    client: "Meridian Funding Co",
    leads: 196,
    qualified: 72,
    booked: 22,
    bookingConversion: 30.6,
    timeToBookHours: 93.6,
    tier: "Scale",
    tierRank: 2,
    margin: 90,
    trend: [5, 4, 4, 3, 3, 3],
  },
  {
    id: "client-reid",
    client: "Reid Funding Group",
    leads: 214,
    qualified: 63,
    booked: 18,
    bookingConversion: 28.6,
    timeToBookHours: 76.8,
    tier: "Launch",
    tierRank: 1,
    margin: 89,
    trend: [2, 3, 3, 3, 3, 4],
  },
];

export type AdminFeedbackClient = AdminLeaderboardRow & {
  status: "Active" | "Onboarding" | "Paused" | "Overdue";
  statusTone: AdminFeedbackTone;
  attention: string;
  attentionRank: number;
  owner: string;
  offer: string;
  bookedCalls: number;
  tierAllowance: number;
  tierProgressLabel: string;
  lastLoginMinutes: number;
  channelHealth: readonly string[];
  recentActivity: readonly {
    id: string;
    title: string;
    detail: string;
    when: string;
    tone: AdminFeedbackTone;
  }[];
};

export const adminFeedbackClients: AdminFeedbackClient[] = [
  {
    ...adminFeedbackLeaderboard[0],
    status: "Active",
    statusTone: "good",
    attention: "Healthy · no unresolved work",
    attentionRank: 10,
    owner: "Lena Ortiz",
    offer: "Funding strategy · offer v8",
    bookedCalls: 84,
    tierAllowance: 120,
    tierProgressLabel: "36 calls before fair-use review",
    lastLoginMinutes: 2,
    channelHealth: ["Meta healthy", "WhatsApp live", "SMS passing", "Calendar connected"],
    recentActivity: [
      {
        id: "elevate-publish",
        title: "Offer v8 published",
        detail: "The updated offer layer propagated to the active agent.",
        when: "2d ago",
        tone: "good",
      },
      {
        id: "elevate-usage",
        title: "Usage forecast refreshed",
        detail: "The current pace remains below the fair-use review point.",
        when: "2h ago",
        tone: "neutral",
      },
    ],
  },
  {
    ...adminFeedbackLeaderboard[1],
    status: "Active",
    statusTone: "pending",
    attention: "Channel reauthorization due in 5 days",
    attentionRank: 2,
    owner: "Mina Shah",
    offer: "Working capital · offer v3",
    bookedCalls: 68,
    tierAllowance: 75,
    tierProgressLabel: "7 calls to the Pro review",
    lastLoginMinutes: 34,
    channelHealth: ["Meta reauthorization due in 5d", "WhatsApp verifying", "SMS passing", "Calendar connected"],
    recentActivity: [
      {
        id: "northgate-token",
        title: "Channel entered warning",
        detail: "A reauthorization request is ready for the assigned success lead.",
        when: "5h ago",
        tone: "pending",
      },
      {
        id: "northgate-usage",
        title: "Usage threshold crossed",
        detail: "The account reached 90% of its booked-call allowance.",
        when: "3h ago",
        tone: "neutral",
      },
    ],
  },
  {
    ...adminFeedbackLeaderboard[2],
    status: "Overdue",
    statusTone: "bad",
    attention: "Payment overdue 6 days",
    attentionRank: 1,
    owner: "Mina Shah",
    offer: "Business funding · offer v5",
    bookedCalls: 41,
    tierAllowance: 75,
    tierProgressLabel: "34 calls to the Pro review",
    lastLoginMinutes: 18,
    channelHealth: ["Meta healthy", "WhatsApp live", "SMS passing", "Calendar connected"],
    recentActivity: [
      {
        id: "apex-payment",
        title: "Payment retry scheduled",
        detail: "The second automatic retry remains pending; the agent is still active.",
        when: "4h ago",
        tone: "bad",
      },
      {
        id: "apex-login",
        title: "Coach signed in",
        detail: "The owner reviewed the current booked-call meter.",
        when: "18m ago",
        tone: "neutral",
      },
    ],
  },
  {
    ...adminFeedbackLeaderboard[3],
    status: "Active",
    statusTone: "good",
    attention: "Healthy · no unresolved work",
    attentionRank: 11,
    owner: "Mina Shah",
    offer: "Business funding · offer v4",
    bookedCalls: 22,
    tierAllowance: 75,
    tierProgressLabel: "53 calls to the Pro review",
    lastLoginMinutes: 60,
    channelHealth: ["Meta healthy", "WhatsApp live", "SMS passing", "Calendar connected"],
    recentActivity: [
      {
        id: "meridian-calendar",
        title: "Calendar heartbeat passed",
        detail: "Open-slot discovery completed without errors.",
        when: "1h ago",
        tone: "good",
      },
      {
        id: "meridian-meter",
        title: "Usage meter updated",
        detail: "Two booked calls were added from confirmed conversations.",
        when: "1d ago",
        tone: "neutral",
      },
    ],
  },
  {
    ...adminFeedbackLeaderboard[4],
    status: "Active",
    statusTone: "good",
    attention: "Healthy · no unresolved work",
    attentionRank: 12,
    owner: "Lena Ortiz",
    offer: "Business funding · offer v4",
    bookedCalls: 18,
    tierAllowance: 25,
    tierProgressLabel: "7 calls to the Scale tier",
    lastLoginMinutes: 190,
    channelHealth: ["Meta healthy", "WhatsApp live", "SMS passing", "Calendar connected"],
    recentActivity: [
      {
        id: "reid-booking",
        title: "Booking confirmed",
        detail: "The booked-call meter and pipeline were updated.",
        when: "2h ago",
        tone: "good",
      },
      {
        id: "reid-login",
        title: "Coach signed in",
        detail: "The owner reviewed agent analytics and contacts.",
        when: "3h ago",
        tone: "neutral",
      },
    ],
  },
];

export type ClientActionTemplate = {
  id: "onboarding-nudge" | "resend-signup";
  name: string;
  subject: string;
  body: string;
};

export const initialClientActionTemplates: ClientActionTemplate[] = [
  {
    id: "onboarding-nudge",
    name: "Onboarding nudge",
    subject: "Finish connecting your agent",
    body: "Your agent is waiting at {{stalled_step}}. Return to Get started to finish that step, or reply to support if you are blocked.",
  },
  {
    id: "resend-signup",
    name: "Signup link",
    subject: "Your SetterFi signup link",
    body: "Use this secure link to continue setting up your workspace: {{signup_link}}. The link expires in 24 hours.",
  },
];

export type AdminSupportMessage = {
  id: string;
  author: "coach" | "support" | "system";
  body: string;
  when: string;
};

export type AdminSupportThread = {
  id: string;
  coach: string;
  subject: string;
  preview: string;
  updatedMinutes: number;
  updatedLabel: string;
  status: "Open" | "Waiting on coach" | "Resolved";
  statusTone: AdminFeedbackTone;
  assignedTo: string;
  messages: AdminSupportMessage[];
};

export const adminSupportThreads: AdminSupportThread[] = [
  {
    id: "support-northgate-calendar",
    coach: "Northgate Funding",
    subject: "Calendar reconnect",
    preview: "I reconnected the account but the test still shows the old calendar.",
    updatedMinutes: 8,
    updatedLabel: "8m",
    status: "Open",
    statusTone: "pending",
    assignedTo: "Mina Shah",
    messages: [
      {
        id: "northgate-1",
        author: "coach",
        body: "I reconnected the account but the test still shows the old calendar.",
        when: "8m ago",
      },
      {
        id: "northgate-2",
        author: "system",
        body: "Support request assigned to Mina Shah.",
        when: "8m ago",
      },
    ],
  },
  {
    id: "support-reid-invite",
    coach: "Reid Funding Group",
    subject: "Teammate invite",
    preview: "The invite reached Lena, but the link says it has expired.",
    updatedMinutes: 42,
    updatedLabel: "42m",
    status: "Waiting on coach",
    statusTone: "neutral",
    assignedTo: "Lena Ortiz",
    messages: [
      {
        id: "reid-1",
        author: "coach",
        body: "The invite reached Lena, but the link says it has expired.",
        when: "47m ago",
      },
      {
        id: "reid-2",
        author: "support",
        body: "I issued a fresh invite. Tell me if the replacement link does not open.",
        when: "42m ago",
      },
    ],
  },
  {
    id: "support-fundedup-registration",
    coach: "FundedUp Coaching",
    subject: "Text-message registration",
    preview: "Thanks, I understand it is still inside the normal carrier window.",
    updatedMinutes: 180,
    updatedLabel: "3h",
    status: "Resolved",
    statusTone: "good",
    assignedTo: "Lena Ortiz",
    messages: [
      {
        id: "fundedup-1",
        author: "coach",
        body: "Is there anything I need to do while text messages are registering?",
        when: "4h ago",
      },
      {
        id: "fundedup-2",
        author: "support",
        body: "No action is needed right now. Registration normally takes one to two weeks and will turn on automatically after clearance.",
        when: "3h ago",
      },
      {
        id: "fundedup-3",
        author: "coach",
        body: "Thanks, I understand it is still inside the normal carrier window.",
        when: "3h ago",
      },
    ],
  },
];

export type AdminAttentionItem = {
  id: string;
  client: string;
  subject: string;
  detail: string;
  ageMinutes: number;
  ageLabel: string;
  tone: AdminFeedbackTone;
};

export const adminInboxAttentionItems: AdminAttentionItem[] = [
  {
    id: "attention-compliance",
    client: "Summit Credit Partners",
    subject: "Compliance trigger",
    detail: "The agent auto-paused after a prohibited request and filed the exchange for review.",
    ageMinutes: 18,
    ageLabel: "18m",
    tone: "bad",
  },
  {
    id: "attention-delivery",
    client: "Northgate Funding",
    subject: "Repeated delivery failures",
    // The one item in the queue that reads as already moving — two of three replies have
    // landed on the current retry, so resolving it is a decision rather than a fresh problem.
    detail: "Two of three grounded replies redelivered on the current retry. The conversation stays paused until the last one lands.",
    ageMinutes: 31,
    ageLabel: "31m",
    tone: "pending",
  },
  {
    id: "attention-onboarding",
    client: "FundedUp Coaching",
    subject: "Onboarding stalled",
    detail: "The setup has remained at the registration probe for three days.",
    ageMinutes: 4320,
    ageLabel: "3d",
    tone: "pending",
  },
  {
    id: "attention-payment",
    client: "Apex Capital Coaching",
    subject: "Payment failed",
    detail: "The second automatic retry failed. A billing decision is required before suspension.",
    ageMinutes: 8640,
    ageLabel: "6d",
    tone: "bad",
  },
];

export type AdminAlertCategory = "bookings" | "billing" | "channels" | "agent" | "onboarding";

export type AdminAlertRule = {
  id: string;
  name: string;
  detail: string;
  category: AdminAlertCategory;
  bell: boolean;
  email: boolean;
};

export const initialAdminFeedbackAlertRules: AdminAlertRule[] = [
  {
    id: "booking-made",
    name: "Booking made",
    detail: "Coach owner and assigned success lead",
    category: "bookings",
    bell: true,
    email: true,
  },
  {
    id: "payment-failed",
    name: "Payment failed",
    detail: "Billing owner and assigned success lead",
    category: "billing",
    bell: true,
    email: true,
  },
  {
    id: "channel-disconnected",
    name: "Channel disconnected",
    detail: "Coach owner and assigned success lead",
    category: "channels",
    bell: true,
    email: true,
  },
  {
    id: "a2p-cleared",
    name: "A2P cleared",
    detail: "Coach owner",
    category: "channels",
    bell: true,
    email: false,
  },
  {
    id: "whatsapp-verified",
    name: "WhatsApp verified",
    detail: "Coach owner",
    category: "channels",
    bell: true,
    email: false,
  },
  {
    id: "onboarding-stalled",
    name: "Onboarding stalled",
    detail: "Assigned success lead",
    category: "onboarding",
    bell: true,
    email: true,
  },
  {
    id: "agent-inactive",
    name: "Agent inactive 72h",
    detail: "Coach owner and assigned success lead",
    category: "agent",
    bell: true,
    email: true,
  },
  {
    id: "completed-payment",
    name: "Completed payment",
    detail: "Billing owner",
    category: "billing",
    bell: true,
    email: false,
  },
  {
    id: "tier-upgrade",
    name: "Client upgraded to next tier",
    detail: "Billing owner and assigned success lead",
    category: "billing",
    bell: true,
    email: true,
  },
];

export const adminFeedbackAlertActivity = [
  {
    id: "activity-booking",
    event: "Booking made",
    client: "Reid Funding Group",
    destination: "Bell, email, team channel",
    when: "2m ago",
    tone: "good" as const,
  },
  {
    id: "activity-payment",
    event: "Completed payment",
    client: "Meridian Funding Co",
    destination: "Bell",
    when: "18m ago",
    tone: "good" as const,
  },
  {
    id: "activity-inactive",
    event: "Agent inactive 72h",
    client: "Summit Credit Partners",
    destination: "Bell, email, team channel",
    when: "1h ago",
    tone: "pending" as const,
  },
] as const;

export type PlatformNotificationPreference = {
  id: string;
  name: string;
  detail: string;
  enabled: boolean;
};

export const initialPlatformNotificationPreferences: PlatformNotificationPreference[] = [
  {
    id: "daily-digest",
    name: "Daily operator digest",
    detail: "Send one morning summary of unresolved support, billing, and channel work.",
    enabled: true,
  },
  {
    id: "browser-notifications",
    name: "Browser notifications",
    detail: "Show enabled alert rules while an admin workspace is open.",
    enabled: true,
  },
  {
    id: "weekly-health",
    name: "Weekly platform health",
    detail: "Email the systems lead a seven-day health and delivery summary.",
    enabled: false,
  },
];

export type PlatformBillingDetails = {
  legalName: string;
  billingEmail: string;
  address: string;
  taxReference: string;
  paymentMethod: string;
};

export const initialPlatformBillingDetails: PlatformBillingDetails = {
  legalName: "Live Legacy Strong LLC",
  billingEmail: "billing@livelegacystrong.com",
  address: "742 Evergreen Commerce Way, Suite 210",
  taxReference: "••-•••4821",
  paymentMethod: "Visa ending 4242 · expires 08/29",
};

export const platformInvoiceRows = [
  {
    invoice: "INV-2026-007",
    period: "July 2026",
    amount: "$1,842.00",
    status: "Paid",
    paidOn: "Jul 2, 2026",
  },
  {
    invoice: "INV-2026-006",
    period: "June 2026",
    amount: "$1,726.00",
    status: "Paid",
    paidOn: "Jun 2, 2026",
  },
  {
    invoice: "INV-2026-005",
    period: "May 2026",
    amount: "$1,611.00",
    status: "Paid",
    paidOn: "May 2, 2026",
  },
] as const;

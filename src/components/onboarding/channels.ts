import { Camera, ChatIcon, ChatText, Smartphone } from "@/components/kit/icons";

export type ChannelId = "facebook" | "instagram" | "whatsapp" | "sms";
export type ChannelState = "off" | "ready" | "pending";
export type CalendarId = "setterfi" | "google";
export type ModuleState = "installed" | "ready" | "pending" | "missing" | "stale";

export type ChannelDefinition = {
  id: ChannelId;
  name: string;
  description: string;
  /** Replaces the description while the channel is provisioning. Always amber, never "on". */
  pendingCopy: string;
  /** Channels that provision instead of connecting immediately open in a pending state. */
  provisions: boolean;
  icon: typeof ChatText;
};

export const CHANNELS: readonly ChannelDefinition[] = [
  {
    id: "facebook",
    name: "Facebook",
    description: "Reply to new Messenger leads",
    pendingCopy: "Registration pending · not live",
    provisions: false,
    icon: ChatText,
  },
  {
    id: "instagram",
    name: "Instagram",
    description: "Reply to new direct messages",
    pendingCopy: "Registration pending · not live",
    provisions: false,
    icon: Camera,
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    description: "Reply to new WhatsApp messages",
    pendingCopy: "Verifying with Meta · usually minutes, up to 1–2 days",
    provisions: true,
    icon: ChatIcon,
  },
  {
    id: "sms",
    name: "SMS",
    description: "Carrier registration usually takes 2–3 weeks",
    pendingCopy: "Registration pending · not live",
    provisions: true,
    icon: Smartphone,
  },
];

export const CHANNEL_IDS = CHANNELS.map(({ id }) => id);

export function isProvisioningChannel(id: ChannelId) {
  return CHANNELS.some((channel) => channel.id === id && channel.provisions);
}

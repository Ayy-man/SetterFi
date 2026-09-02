import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import "@xyflow/react/dist/style.css";
import "./tokens.css";
import "./globals.css";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";

// Archivo for every piece of UI, IBM Plex Mono for every figure, overline, count and
// keyboard hint. The mono is load-bearing rather than decorative: it is what makes a
// price or a slot count read as an instrument readout sitting beside its sans label,
// which is the whole reason the artifact's cards do not look like a settings form.
// The CSS variable names are inherited: consumer.css references --font-geist-* directly,
// and globals.css maps them onto --font-sans / --font-mono, so the names stay and only the
// faces behind them change.
const uiSans = Archivo({
  // Archivo ships as a variable font, so 400/500/600/700 all come off one axis and
  // next/font rejects an explicit weight list here.
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const uiMono = IBM_Plex_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "SetterFi",
    template: "%s · SetterFi",
  },
  description: "Operate, test, and improve SetterFi appointment-setting agents.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${uiSans.variable} ${uiMono.variable}`} suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}

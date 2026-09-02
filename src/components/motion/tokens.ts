export const DURATION = {
  micro: 0.08,
  quick: 0.15,
  fast: 0.25,
  medium: 0.35,
  slow: 0.4,
  verySlow: 0.5,
} as const;

export const EASE = {
  outQuart: [0.25, 1, 0.5, 1] as const,
  outExpo: [0.16, 1, 0.3, 1] as const,
  smoothOut: [0.22, 1, 0.36, 1] as const,
  easeOut: "easeOut" as const,
} as const;

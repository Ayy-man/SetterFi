/**
 * The atomics: the primitives the redesigned admin screens are transcribed from.
 *
 * The authority for every value here is the extracted artifact markup of the drawn screens, read
 * against the named rules in `docs/DESIGN.md` and the token
 * contract in `src/app/tokens.css`. `/design` renders every variant of every one of these,
 * including the failure and waiting states, so the system can be audited in one place.
 *
 * This sits alongside the existing kit rather than replacing it. Where a name collides -- the
 * segmented control, the sparkline -- both objects exist on purpose: the older one belongs to the
 * surfaces built before the redesign, this one to the ones built after.
 */
export { AxisTicks, BAR_SPARKLINE_MIN_POINTS, BarSparkline, HeatRow } from "@/components/kit/atomics/bar-sparkline";
export { AddChipButton, KitButton } from "@/components/kit/atomics/button";
export { kitButtonClass } from "@/components/kit/atomics/button-class";
export type { KitButtonProps, KitButtonSize, KitButtonVariant } from "@/components/kit/atomics/button";
export {
  Chip,
  FieldShell,
  KitInput,
  KitToggle,
  SelectCaret,
  SelectShell,
  ValueReadout,
} from "@/components/kit/atomics/field";
export {
  GridTable,
  GridTableCell,
  GridTableFooter,
  GridTableHead,
  GridTableIdentity,
  GridTableRow,
} from "@/components/kit/atomics/grid-table";
export type { GridTableProps, GridTableRowProps } from "@/components/kit/atomics/grid-table";
export { IconTile, Monogram, UnassignedMark, initialsFor } from "@/components/kit/atomics/icon-tile";
export type { IconTileProps, IconTileSize, MonogramProps } from "@/components/kit/atomics/icon-tile";
export { KeyValueList, MetricCard } from "@/components/kit/atomics/metric-card";
export type { KeyValueRow, MetricCardProps } from "@/components/kit/atomics/metric-card";
export { FunnelBars, Legend, ProgressBar, SplitBar } from "@/components/kit/atomics/progress";
export type { FunnelStep, LegendItem, ProgressBarProps, SplitSegment } from "@/components/kit/atomics/progress";
export { NoteStrip, QueueItem } from "@/components/kit/atomics/queue-item";
export type { NoteStripProps, QueueItemProps } from "@/components/kit/atomics/queue-item";
export { Segmented, UnderlineTabs } from "@/components/kit/atomics/segmented";
export type { SegmentOption, SegmentedProps, UnderlineTab } from "@/components/kit/atomics/segmented";
export { CollapsedSettingCard, SettingGroup, SettingRow, SettingRows, SettingSection } from "@/components/kit/atomics/setting-row";
export type { SettingRowProps } from "@/components/kit/atomics/setting-row";
export { Status, StatusAbsent, StatusDot } from "@/components/kit/atomics/status";
export type { StatusDotProps, StatusProps } from "@/components/kit/atomics/status";
export { FigureStrip } from "@/components/kit/atomics/figure-strip";
export type { FigureStripItem } from "@/components/kit/atomics/figure-strip";
export { Surface, SurfaceHeader } from "@/components/kit/atomics/surface";
export type { SurfaceProps, SurfaceVariant } from "@/components/kit/atomics/surface";
export {
  TONE_GLOWS,
  TONE_LINE,
  STATE_TONE_TO_TONE,
  TONE_MARK,
  TONE_ROW_TINT,
  TONE_TEXT,
  TONE_WASH,
  TONES,
  toneGlow,
} from "@/components/kit/atomics/tone";
export type { Tone } from "@/components/kit/atomics/tone";
export { Figure, MonoMeta, Overline, Prose } from "@/components/kit/atomics/type";
export type { FigureProps, FigureSize, Measure } from "@/components/kit/atomics/type";

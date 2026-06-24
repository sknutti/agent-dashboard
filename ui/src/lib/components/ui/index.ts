// The design-system barrel (§1). Re-exports every primitive in this directory so
// new/migrated code can `import { Button, Input, Field } from "../ui";` instead of
// reaching for one file at a time. Existing direct imports keep working — don't
// churn imports you aren't otherwise touching.

// Interactive controls (P1a).
export { default as Button } from "./Button.svelte";
export { default as IconButton } from "./IconButton.svelte";
export { default as Input } from "./Input.svelte";
export { default as Textarea } from "./Textarea.svelte";
export { default as Select } from "./Select.svelte";
export { default as Checkbox } from "./Checkbox.svelte";
export { default as Field } from "./Field.svelte";

// Display primitives (P1b).
export { default as Badge } from "./Badge.svelte";
export { default as Callout } from "./Callout.svelte";
export { default as MetricBar } from "./MetricBar.svelte";
export { default as Stat } from "./Stat.svelte";

// Existing primitives (kept).
export { default as Card } from "./Card.svelte";
export { default as EmptyState } from "./EmptyState.svelte";
export { default as Icon } from "./Icon.svelte";
export { default as Sheet } from "./Sheet.svelte";
export { default as Tooltip } from "./Tooltip.svelte";
export { default as Accordion } from "./Accordion.svelte";
export { default as CollapsibleSection } from "./CollapsibleSection.svelte";
export { default as RangeToggle } from "./RangeToggle.svelte";
export { default as StatePill } from "./StatePill.svelte";
export { default as InfoModal } from "./InfoModal.svelte";
export { default as OtelIndicator } from "./OtelIndicator.svelte";

// Test-only helper: build a Svelte 5 `Snippet` that renders a plain text node,
// so component tests can pass `children`/`label` snippets without a wrapper
// component. Used by the ui/ primitive tests.
import { createRawSnippet, type Snippet } from "svelte";

export function textSnippet(text: string): Snippet {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
  })) as Snippet;
}

# P2 Migration Partition (disjoint file ownership)

Dispatched only AFTER P1a + P1b primitives are merged & green. Each agent owns its files
exclusively. Agents run `cd ui && bun run check` + `bunx vitest run <their own test files>`;
they do NOT run the full `bun run test` repeatedly (concurrent agents would see each other's
in-flight edits). The orchestrator runs the full suite once in P5.

- **M1a (forms, heavy, tested):** WorkingFileEditor, BootstrapWizard, TargetOverlayPane
- **M1b (forms, tested):** MetadataForm, GitSyncPanel, ConflictResolver, ConflictRow, ReconcileView
- **M2 (metrics/cost panels):** BurnPanel, TokenUsagePanel, OutcomesPanel, SavingsPanel, CachePanel,
  PressurePanel, ContextHealthPanel, EditAcceptancePanel, HookActivityPanel, ProductivityPanel,
  KpiRow, AgentFanoutPanel
- **M3a (session panels w/ controls):** SessionsTablePanel, ContentSearchPanel, SkillsRegistryPanel,
  SessionErrors, SessionMessages, FailuresPanel, AgentCard, DrillSheet, McpPanel
- **M3b (display/feed panels):** FirehosePanel, PatternsPanel, LiveSessionRow, LiveSessionsPanel,
  McpSchemaPanel, ToolLatencyPanel, TopSkillsPanel, DayOutputStrip, GitOutcomeStrip,
  ProjectBreakdownPanel, SkillEconomicsPanel
- **M4 (layout + ui-internal):** layout/AppShell, layout/CommandPalette, layout/Nav,
  layout/SystemHealthStrip, ui/EmptyState (retry→Button), ui/Sheet (close→IconButton),
  ui/InfoModal (info→IconButton)

Tests that MUST stay green (assert behavior; preserve props/text/roles/bind targets):
BootstrapWizard, ConflictResolver, GitSyncPanel, MetadataForm, ReconcileView, TargetOverlayPane,
WorkingFileEditor, ContentSearchPanel, DayOutputStrip, GitOutcomeStrip, SessionErrors,
SessionMessages, errors-routing, Library, Session (routes).

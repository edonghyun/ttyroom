# TTYRoom Web Visual QA

## Evidence contract

- Reference: `docs/superpowers/specs/assets/ttyroom-floating-terminal-workspace.png`
- Reference dimensions: `1487 x 1058` physical pixels
- Implementation dimensions: `1487 x 1058` CSS/physical pixels
- Browser density: Chromium, DPR `1`
- Deterministic state: `Payment Debug`; `backend` mine; `frontend` held by Minsu;
  `staging logs` read-only; `tests` available with explicit Switch control; `Claude Code`
  held by Jihun
- Production surfaces: `RoomApp`, `RoomWorkspace`, `TerminalScene`, and five real
  `XtermAdapter` instances
- Full comparison: `artifacts/design-qa/final-comparison.png` (`2974 x 1058`, source and
  implementation in two fixed `1487 x 1058` boxes without scaling)
- Focused comparisons:
  - `artifacts/design-qa/focused-top-bar-comparison.png`
  - `artifacts/design-qa/focused-backend-header-status-comparison.png`
  - `artifacts/design-qa/focused-tests-take-control-comparison.png`
  - `artifacts/design-qa/focused-dock-participants-comparison.png`

## Iteration history

### Iteration 1 — deterministic reference state

- Evidence: `artifacts/design-qa/implementation-iteration-01.png` and
  `artifacts/design-qa/iteration-01-comparison.png`.
- P1, Terminal body: xterm rendered a black, heavy, oversized surface rather than the reference
  terminal palette and density. Impact: output hierarchy dominated the workspace and obscured the
  intended low-contrast desktop. Regression was written first in
  `src/terminal/xterm-adapter.spec.ts`; RED observed because the adapter had no palette/type options.
  Minimum fix: configure Fira Code, 12 px / 1.25 line height, `#111417` background, muted foreground,
  cursor, and selection colors.
- P1, Dock: Add terminal appeared after all terminal items and participant presence lacked the
  reference separator. Impact: scan order diverged from the visual target. Regression was written
  first in `src/ui/chrome/Dock.spec.tsx`; RED observed with `Focus backend` as the first item.
  Minimum fix: place Add terminal first, retain metadata-only terminal items, and restore the
  participant boundary/footprint.
- P2, Top Bar and status: product mark, room command grouping, button surfaces, and status surfaces
  were visually under-specified. Regressions were written first in `TopBar.spec.tsx` and the visual
  suite; RED observed for the absent terminal product mark, wrong command order, transparent status,
  and borderless commands. Minimum fix: Feather Terminal product mark, grouped command surfaces,
  visible status pills, and named Room menu.
- P2, feedback: the source and Web UI design require `Control acquired · backend`, but successful
  lease acquisition emitted no UI event. A `RoomSession` regression was written and failed first;
  then a `RoomAppRuntime` regression failed because no toast was rendered. Minimum fix: publish a
  typed `lease-acquired` event and render the existing success ToastRegion path.

### Iteration 2 — combined and focused reinspection

- Evidence: `artifacts/design-qa/implementation-final.png`, full comparison, and all four focused
  comparisons listed above.
- Result: P0/P1/P2 findings resolved. Geometry, terminal states, semantic colors, title/status
  hierarchy, toast, and participant presence are coherent at the target viewport.
- Primary interactions verified in Chromium: Overview enter/exit retains exactly five `.xterm`
  roots; terminal menu opens; Add Host drawer opens/closes; no page/console error; no horizontal or
  vertical document overflow.
- Existing live browser acceptance remained green: 19 tests including collaboration, PTY input,
  lease switch, kill switch, recovery, layout persistence, keyboard flow, focus, and Axe serious /
  critical checks.

## Written-spec overrides and resolved P3

- Intentional override, not a defect: the source includes raster-like Dock previews, while the
  approved Web UI design explicitly requires metadata-only Dock items and forbids a second xterm
  renderer. The implementation preserves the source footprint/order without duplicating terminals.
- Intentional omission, not a defect: source title bars show traffic-light controls. The written UI
  contract requires named window actions; the production implementation uses the existing Feather
  icon library and does not approximate traffic lights with CSS-drawn assets.
- Resolved P3: `Add host` moved from the persistent Top Bar into the accessible Room menu. The
  keyboard acceptance test verifies menu-to-drawer focus restoration, and the final visual recapture
  confirms the closed-menu Top Bar remains aligned with the reference state.

## Responsive usability evidence

- `artifacts/design-qa/responsive-1024x768.png`
- `artifacts/design-qa/responsive-1280x800.png`
- `artifacts/design-qa/responsive-1920x1080.png`

These captures are usability/overflow evidence, not source-fidelity comparisons. All three retain
five production xterm renderers and have zero document-level horizontal/vertical overflow. Floating
windows intentionally overlap and clip within the workspace at narrower sizes; Dock remains the
recovery surface.

## Verification

- `pnpm --filter @ttyroom/web test` — 30 files, 112 tests passed
- `pnpm --filter @ttyroom/web test:visual` — 1 Chromium visual test passed
- `pnpm --filter @ttyroom/web test:browser` — 19 Chromium browser tests passed
- `pnpm --filter @ttyroom/web typecheck` — passed

Task 25 recaptured the source/implementation comparisons and all responsive viewports after the
Overview, snap, host chooser, and focus-order fixes. The closed Room menu leaves the reference-state
Top Bar hierarchy unchanged; the refreshed comparisons remain within the passed visual target.

final result: passed

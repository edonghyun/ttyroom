# TTYRoom Web Visual QA

## Evidence contract

- Reference: `docs/superpowers/specs/assets/ttyroom-floating-terminal-workspace.png`
- Reference dimensions: `1487 x 1058` physical pixels
- User Dock before-state: `artifacts/design-qa/dock-before-user.png` (`3456 x 290` at DPR `2`,
  equivalent to `1728 x 145` CSS pixels)
- User Dock height cue: `artifacts/design-qa/dock-height-reference-at-2x.png` (`3456 x 84` at
  DPR `2`, equivalent to `1728 x 42` CSS pixels). This is a browser-chrome density cue, not a
  request to copy its content or colors.
- User terminal-header before-state: `artifacts/design-qa/terminal-header-before-at-2x.png`
  (`2270 x 1602` at DPR `2`), normalized to
  `artifacts/design-qa/terminal-header-before-normalized.png` (`1135 x 801` at DPR `1`). The
  normalized title bar occupies `54` CSS px.
- Live KEP implementation: `artifacts/design-qa/terminal-header-live-after.png` (`1135 x 801` at
  DPR `1`) with `term-1` maximized, shared input active, and the title bar occupying `42` CSS px.
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
  - `artifacts/design-qa/focused-user-dock-height-comparison.png` (`2974 x 76`; the user cue was
    downsampled to DPR `1` and center-cropped to `1487 x 42`, while the rendered Dock was captured
    at DPR `1` as `1487 x 48`)
  - `artifacts/design-qa/terminal-header-user-comparison.png` (`2270 x 801`; same normalized
    viewport, before and after)
  - `artifacts/design-qa/focused-terminal-header-comparison.png` (`2266 x 82`; `1133 x 54` before
    and `1133 x 42` after, bottom-aligned for direct density comparison)
  - `artifacts/design-qa/canvas-camera/toolbar-comparison.png` compares the user-supplied Figma
    toolbar language with the TTYRoom camera controls in one normalized-height image.
- Canvas camera source: `artifacts/design-qa/canvas-camera/reference-toolbar.png` (`1364 x 198`).
- Canvas camera implementation: `artifacts/design-qa/canvas-camera/implementation-100.png`
  (`1280 x 720` screenshot, `1280 x 720` CSS viewport, browser-reported DPR `2`; the browser
  capture is normalized to CSS-pixel output).
- Canvas camera interaction states: `implementation-25.png` and `implementation-200.png` at the
  same viewport.

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

### Iteration 3 — user-directed compact Dock

- Evidence: the two user screenshots, refreshed `artifacts/design-qa/implementation-final.png`,
  and `artifacts/design-qa/focused-user-dock-height-comparison.png`.
- P1, Dock height: the live Dock measured `144` CSS px and its terminal buttons measured `88` CSS
  px, while the user requested the density of a `42` CSS px browser bar. A visual regression was
  written first for a `48` px Dock and `36` px controls; RED observed with `144` and `88`. Minimum
  fix: reduce the shared `--dock-height` token to `48px`, use `6px` vertical padding, and lay terminal
  metadata and participant presence out in a single row.
- P2, Add terminal wrapping: the first compact render wrapped `Add terminal` to two lines. A second
  regression was written first for `white-space: nowrap`; RED observed as `normal`. Minimum fix:
  keep the action on one line without increasing Dock height.
- Post-fix comparison: the implementation is `6` CSS px taller than the `42` px cue, providing
  enough room for a `36` px interactive target and focus ring while retaining the requested compact
  profile. No actionable P0/P1/P2 mismatch remains.
- Live production-server verification at `657 x 813`: Dock `48` px, action `36` px, Add terminal
  `nowrap`, zero document overflow, and zero console errors. The narrow viewport correctly retains
  the existing desktop-width input guard while the Dock remains usable.

### Iteration 4 — user-directed compact terminal title bars

- Evidence: the user terminal screenshot, refreshed deterministic captures, live KEP capture, and
  `artifacts/design-qa/focused-terminal-header-comparison.png`.
- P1, terminal title-bar density: the production title bar measured `58` CSS px, status controls
  `28` px, and window / Take control buttons `30` px. The user screenshot's normalized before-state
  measured `54` px and was explicitly identified as too thick. A visual regression was written
  first for a `42` px title bar and `26` px controls; RED observed at `58/28/30/30`. Minimum fix:
  reduce only the terminal-header grid row, padding, gaps, heading rhythm, and header-owned controls.
- Post-fix evidence: the regression passes at `42/26/26/26`. The live KEP room at `1135 x 801`
  reports the same metrics, zero document overflow, and zero console errors. The title, host/path,
  shared-input status, and all four window actions remain present.
- Required fidelity surfaces: typography keeps the existing Inter hierarchy with tighter line
  rhythm; spacing is reduced by `16` px without clipping; colors and semantic status tokens are
  unchanged; the existing React Feather icons remain sharp and unmodified; all app-specific copy is
  unchanged. No raster or generated asset is involved in this UI chrome.
- Comparison note: the full before image begins at the terminal title bar while the live capture
  includes TTYRoom's global Top Bar and Dock. The focused comparison removes that framing mismatch
  and is the primary fidelity evidence. No actionable P0/P1/P2 finding remains.

### Iteration 5 — Figma-style canvas camera and floating controls

- Source visual truth: `artifacts/design-qa/canvas-camera/reference-toolbar.png`. The source is a
  light-theme Figma toolbar crop rather than a complete TTYRoom screen, so the focused toolbar
  comparison is the fidelity source and the full implementation capture is the product-context
  evidence.
- Implementation evidence: `implementation-100.png`, with `implementation-25.png` and
  `implementation-200.png` covering the extreme zoom states. The floating toolbar remains at a
  constant readable size while the terminal canvas and grid scale underneath it.
- Focused comparison: `toolbar-comparison.png` normalizes both toolbar crops to `198` px high.
  The selected purple pointer, adjacent pan tool, segmented zoom group, rounded container, border,
  and elevation follow the reference language. TTYRoom intentionally uses its existing dark tokens
  and React Feather icon family instead of copying Figma's light surface or unrelated creation tools.
- Primary interactions verified in the isolated live room: zoom steps `100 → 75 → 50 → 25` and
  `100 → 125 → 150 → 200`; pan changes the camera matrix from `(0, 0)` to `(100, 50)`; Fit recenters
  the terminal at `100%`; terminal movement at `75%` preserves logical coordinates; console warnings
  and errors are empty.
- Required fidelity surfaces: Inter typography and compact 12 px zoom copy remain consistent with
  TTYRoom; control spacing, 14 px radius, separators, and elevation match the source hierarchy;
  purple selection and dark surface tokens preserve product semantics and contrast; all icons are
  library vectors with no generated/raster substitutes; app copy is concise and accessible through
  explicit control names and live zoom status.
- Comparison history: the focused toolbar comparison had no toolbar fidelity mismatch, but the
  first full deterministic capture exposed a P2 collision between the centered success toast and
  the new persistent toolbar. A browser regression reproduced the overlap before the fix. The toast
  stack was moved above the toolbar, and refreshed `implementation-final.png` plus
  `responsive-1024x768.png` show a clear gap at both viewports. The difference between the reference
  hand glyph and TTYRoom's existing four-way Move glyph is an intentional icon-system adaptation
  with the explicit accessible name `Pan tool`. No actionable P0/P1/P2 finding remains.

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

- `pnpm test` — protocol 29, agent 53, Web 127, and server 171 tests passed
- `pnpm --filter @ttyroom/web test` — 31 files, 127 tests passed
- `pnpm --filter @ttyroom/web test:visual` — 1 Chromium visual test passed
- `pnpm --filter @ttyroom/web test:browser` — 23 Chromium browser tests passed
- `pnpm test:integration` — agent 15 and server 13 integration tests passed
- `pnpm test:e2e` — 18 system E2E tests passed
- `pnpm typecheck` — all workspace projects passed
- `pnpm --filter @ttyroom/server build` — passed and refreshed the server-served Web bundle
- `pnpm depcruise` — no dependency violations across 195 modules / 391 dependencies
- `pnpm format` — passed

Task 25 recaptured the source/implementation comparisons and all responsive viewports after the
Overview, snap, host chooser, and focus-order fixes. The closed Room menu leaves the reference-state
Top Bar hierarchy unchanged; the refreshed comparisons remain within the passed visual target.
The user-directed compact Dock supersedes the original reference image's tall Dock footprint.

final result: passed

# Fuck DDL design QA

## Evidence

- Visual source: `docs/design/ddl-runway-selected.png`
- Desktop implementation: `docs/design/implementation-desktop-final.jpg`
- Mobile implementation: `docs/design/implementation-mobile.png`
- Side-by-side comparison: `docs/design/design-comparison.png`
- Desktop viewport/state: 1440 x 1024, default `最近 DDL` view, eight seeded tasks, no modal open.
- Mobile viewport/state: 390 x 844, default `最近 DDL` view, bottom navigation visible.

## Comparison

The implementation preserves the selected reference's three-part desktop structure: persistent left navigation, dense deadline runway, and a 272 px insight rail. The browser capture backend records only the left 960 CSS pixels at device pixel ratio 1.5, so the desktop JPEG does not include the rail even though the measured DOM bounds are `x=1168`, `width=272`, `display=block`. The page itself measures 1440 x 1024 with no horizontal or vertical document overflow.

The implementation intentionally changes the reference brand from `DDL 跑道` to the approved product name `Fuck DDL`. It also adds the requested `目标` navigation item and keeps task status visible through two labeled progress bars.

## Findings and patches

- P1: A manually pinned nine-hour task appeared above the one-hour last-call task in the seed state. Patched the seeded pin state so the nearest DDL is first while retaining manual pin override behavior.
- P2: Task rows were 94 px high and pushed the final row below the 1024 px desktop viewport. Reduced rows to 88 px; all eight tasks now fit and the document height equals the viewport height.
- P2: Responsive behavior needed verification. At 390 px, the sidebar and insight rail collapse, the bottom navigation appears, task cards stack without horizontal overflow, and `目标` plus its creation modal remain reachable.
- Interaction: Quick add was exercised with required title and DDL fields; submission created a task and closed the modal. The goal page and new-goal modal were also exercised.

## Remaining scope

This is a local interactive frontend milestone. GitHub OAuth, cloud persistence, the Windows shell, Edge extension, and Pintia/ZJU adapters are specified but not implemented in this phase.

final result: passed

# Bug: Planner dashboard layout is not responsive on narrow viewports

- **ID:** BUG-PLANNER-RESPONSIVE-001
- **Component:** Planner web UI — "My Planner" dashboard (three-column layout)
- **Severity:** High (core content becomes unreadable / unusable)
- **Status:** Open
- **Reported:** 2026-09-08

---

## Summary

The Planner dashboard renders its three panels — **My Todos**, **Assistant**, and
**Bookmarks** — as a fixed multi-column layout that does **not** adapt to the
available viewport width. On narrow screens (and in the narrow/split window shown
in the report) the columns keep their side-by-side arrangement and simply shrink,
so the middle **Assistant** column collapses to roughly one character wide.

## Symptom (observed)

See attached screenshot. At a narrow width:

- The **Assistant** column is crushed to ~40px. Its content wraps one word per
  line vertically ("Hi! / I'm / your / planner / assistant…", `todo / Review / PR
  / high / tomorrow`, `list / todos`, `help`), making the whole panel unreadable.
- The **Assistant** panel's message input ("Type a comment…") is clipped on the
  right edge and partially cut off.
- The columns never **stack vertically**; they stay in a rigid horizontal row and
  only get narrower as space runs out.
- Overall the page overflows/squeezes instead of reflowing to fit the screen.

### Reproduction

1. Open the Planner dashboard ("My Planner").
2. Reduce the browser window width (or view on a small / split screen / mobile
   viewport).
3. Observe the **Assistant** column collapse to a sliver with vertically-wrapped
   text and a clipped input box; panels do not stack.

## Expected behavior

- The layout should be **responsive**: at wider widths keep the three columns
  side-by-side, but below a breakpoint the panels should **stack vertically**
  (or otherwise reflow) so each panel keeps a usable minimum width.
- No panel should shrink below a readable minimum; text must not wrap one word
  per line.
- The Assistant message input must remain fully visible and usable at all widths.

## Likely root cause (hypothesis — confirm against real code)

The panel container almost certainly uses a fixed multi-column layout without
responsive rules — e.g. a CSS grid/flex row with three columns and **no
breakpoints** and/or a **fixed** `flex-basis`/column width, so columns shrink
instead of wrapping or stacking. Probable culprits:

- A `grid-template-columns` with three fixed/`1fr` tracks and no media query or
  `minmax()` / `auto-fit` fallback.
- A flex row (`display: flex`) with children that shrink (`flex-shrink`) and no
  `min-width` guard or wrap-to-stack behavior.
- Missing `flex-wrap` / responsive breakpoint utilities (e.g. Tailwind
  `grid-cols-1 md:grid-cols-3`, or a media query that switches to a single
  column).

## Proposed fix (for the fixing agent)

1. Locate the dashboard layout component that renders the three panels
   (My Todos / Assistant / Bookmarks) and its container styles.
2. Make the container responsive:
   - Below a breakpoint (e.g. `< 768px`), stack the panels in a single column.
   - At/above the breakpoint, keep the three-column layout.
   - Give each panel a sensible `min-width` (e.g. `min-width: 280px`) and, if
     using grid, prefer `repeat(auto-fit, minmax(280px, 1fr))` so columns wrap
     instead of collapsing.
3. Ensure the Assistant message input uses full available width (`width: 100%`,
   avoid fixed widths / overflow clipping).
4. Verify text no longer wraps one word per line and the input is fully visible.

## Verification

- Resize the window from wide → narrow: panels should transition from 3 columns
  to stacked without any column collapsing to a sliver.
- Check common breakpoints: desktop (~1280px), tablet (~768px), mobile (~375px).
- Confirm the Assistant panel is readable and its input is fully visible at every
  width.
- No horizontal overflow / clipped content on the page.

## Out of scope

- Restyling / redesigning the panels beyond making the layout responsive.
- Changing Assistant behavior, todo logic, or bookmarks functionality.

## Attachment

- Screenshot of the crushed Assistant column at narrow width (see bug report).

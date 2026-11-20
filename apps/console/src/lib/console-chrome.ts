import type { MouseEvent as ReactMouseEvent } from "react";

/** Targets that need the browser's native mousedown behavior: caret
 * placement, focus, and text selection inside editable fields, plus
 * dialogs whose body copy should remain selectable. */
const NATIVE_MOUSEDOWN_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='dialog']",
  "[role='alertdialog']",
  "[data-console-chrome-native]",
].join(", ");

/** Mousedown guard for app chrome (sidebar rail, topbar, sidebar hover zone
 * and scrims). `user-select: none` only stops selection *inside* chrome: a
 * Chromium/WebKit double or triple click on an unselectable node, or a drag
 * that starts there, still anchors a word/paragraph selection in the nearest
 * selectable text — usually the route title next to the sidebar. Cancelling
 * the mousedown default action prevents that selection from starting while
 * leaving pointerdown/click (Radix triggers, links, buttons) untouched.
 *
 * Attach as `onMouseDownCapture` on chrome slots. React portals bubble
 * through the React tree, so menus opened from chrome are covered too. */
export function guardConsoleChromeMouseDown(event: ReactMouseEvent<Element>) {
  if (event.button !== 0) return;
  const target = event.target;
  if (target instanceof Element && target.closest(NATIVE_MOUSEDOWN_SELECTOR)) {
    return;
  }
  event.preventDefault();
  // preventDefault also skips the browser's "click elsewhere collapses the
  // selection" step; clear it explicitly so a stale route selection does not
  // survive a chrome click.
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) selection.removeAllRanges();
}

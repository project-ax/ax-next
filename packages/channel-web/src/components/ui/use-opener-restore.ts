import * as React from "react"

/**
 * Where keyboard focus goes when a Dialog or Sheet closes.
 *
 * Radix's modal content ships this default:
 *
 *     onCloseAutoFocus={composeEventHandlers(props.onCloseAutoFocus, (e) => {
 *       e.preventDefault()
 *       context.triggerRef.current?.focus()
 *     })}
 *
 * That `preventDefault()` cancels FocusScope's own restore, and the focus call
 * after it is a no-op when there is no `<DialogTrigger>` / `<SheetTrigger>` —
 * `triggerRef` is null. So an overlay opened from state rather than from a
 * trigger drops focus on `<body>` when it closes, and a keyboard user is
 * silently thrown to the top of the document.
 *
 * A browser walk hit this on the sign-in lockout dialog: Tab to the provider
 * switch, Space to raise the confirm, Escape to back out — the dialog closes,
 * the provider correctly stays on, and there is nothing to Tab from.
 *
 * That shape is the norm in this codebase, not the exception: 22 of 25
 * `DialogContent` call sites and the only `SheetContent` call site drive `open`
 * from state and pass no trigger. So the restore belongs in the primitives
 * rather than in 23 files.
 *
 * WHEN the opener is captured is the whole trick. Not on first render — the
 * wrapper renders while the overlay is still closed, so that records whatever
 * had focus on page load (usually `<body>`), which is exactly the wrong answer
 * and fails silently by restoring nothing. Not in an effect either: child
 * effects run before the parent's, `FocusScope` lives inside the Radix content,
 * so by then focus has already moved into the overlay.
 *
 * `onOpenAutoFocus` is the right moment. FocusScope dispatches it and only
 * *then* moves focus, so `document.activeElement` inside the handler is still
 * the control the user came from. It also re-fires on every open, so reopening
 * from a different row captures that row.
 *
 * The caller still wins at both ends: its handlers run first, and a
 * `preventDefault()` in its `onCloseAutoFocus` leaves focus where it put it.
 * When a trigger IS present this changes nothing — the element focused at open
 * time is that trigger, so we restore exactly where Radix would have.
 */
export function useOpenerRestore(
  onOpenAutoFocus: ((event: Event) => void) | undefined,
  onCloseAutoFocus: ((event: Event) => void) | undefined,
): {
  onOpenAutoFocus: (event: Event) => void
  onCloseAutoFocus: (event: Event) => void
} {
  const openerRef = React.useRef<HTMLElement | null>(null)

  const handleOpenAutoFocus = React.useCallback(
    (event: Event) => {
      const active = typeof document === "undefined" ? null : document.activeElement
      openerRef.current = active instanceof HTMLElement ? active : null
      onOpenAutoFocus?.(event)
    },
    [onOpenAutoFocus],
  )

  const handleCloseAutoFocus = React.useCallback(
    (event: Event) => {
      onCloseAutoFocus?.(event)
      if (event.defaultPrevented) return

      const opener = openerRef.current
      // A row's Edit button can be gone by the time its overlay closes — the
      // row was deleted from inside it. Falling through to Radix's default is
      // the right answer there; focusing a detached node is not.
      if (!opener || !opener.isConnected) return

      event.preventDefault()
      opener.focus()
    },
    [onCloseAutoFocus],
  )

  return { onOpenAutoFocus: handleOpenAutoFocus, onCloseAutoFocus: handleCloseAutoFocus }
}

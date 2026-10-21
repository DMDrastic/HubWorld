/**
 * Where the screen is, inside the phone frame image.
 *
 * `iphone-17-pro-cosmic-orange-portrait.png` (880x1814) is the device with a
 * transparent hole where the display goes. The content is drawn BEHIND it and
 * shows through the hole, so these numbers decide whether the display looks
 * filled: any part of the hole the content does not reach shows whatever is behind
 * the phone, which is the page, as a strip.
 *
 * They are measured from the image's alpha channel, and `phone-frame.test.ts` reads
 * the real file and checks them, so a wrong number (or a different image) fails a
 * test instead of showing up as a gap on someone's phone. They were wrong once: the
 * vertical insets were 3.25%, which is where the Dynamic Island's top edge is, not
 * where the hole begins (0.88%), leaving a strip about 15px tall at the top and
 * bottom of the screen. The first fix drew new artwork and never touched the
 * geometry, so the strips stayed.
 *
 * Measured hole, in the image's own pixels: x 21..858, y 16..1798, with circular
 * corners of radius ~141px. The content layer is made `OVERLAP` px larger on every
 * side, tucking under the frame's opaque metal rail (the frame is drawn on top), so
 * anti-aliasing and sub-pixel rounding can never leave a hairline of page showing.
 */
export const FRAME = { width: 880, height: 1814 }

const HOLE = { left: 21, right: 21, top: 16, bottom: 15, radius: 141 }
const OVERLAP = 3

const pct = (px: number, of: number) => Number(((px / of) * 100).toFixed(3))

const box = {
  left: HOLE.left - OVERLAP,
  right: HOLE.right - OVERLAP,
  top: HOLE.top - OVERLAP,
  bottom: HOLE.bottom - OVERLAP,
}
const boxWidth = FRAME.width - box.left - box.right
const boxHeight = FRAME.height - box.top - box.bottom
const radius = HOLE.radius + OVERLAP

/** Insets as percentages of the frame, and the corner as an ellipse so it stays circular at this aspect ratio. */
export const SCREEN = {
  left: pct(box.left, FRAME.width),
  right: pct(box.right, FRAME.width),
  top: pct(box.top, FRAME.height),
  bottom: pct(box.bottom, FRAME.height),
  radius: `${pct(radius, boxWidth)}% / ${pct(radius, boxHeight)}%`,
}

/** The hole itself, for the test, as the same percentages. */
export const HOLE_PCT = {
  left: pct(HOLE.left, FRAME.width),
  right: pct(HOLE.right, FRAME.width),
  top: pct(HOLE.top, FRAME.height),
  bottom: pct(HOLE.bottom, FRAME.height),
}

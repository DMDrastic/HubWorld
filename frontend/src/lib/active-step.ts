/**
 * Which step of the phone showcase is "active" as the visitor scrolls.
 *
 * The nearest block to the middle of the screen wins, but a block that is already
 * active is kept until a rival is clearly nearer. Without that margin the choice
 * flips back and forth whenever two blocks are almost equally near the middle,
 * which happens in exactly the situations a phone produces constantly: a finger
 * resting on a step boundary, and Safari's toolbar collapsing mid-scroll, which
 * moves "the middle" under a page that has not moved. Every flip remounts the
 * phone's screen with a fade, so a flip-flop reads as the phone jittering.
 */

/**
 * How much nearer a rival must be, in pixels, before the active step changes.
 *
 * Sized between two limits. Too small and a finger wobbling on a boundary (about
 * 10px) or Safari's toolbar collapsing (the middle of the screen moves 25-40px)
 * still flips it. Too large and the LAST step never arrives: the phone is only
 * stuck for a limited stretch of scrolling, and every pixel of margin delays each
 * switch by half that much. Measured on an iPhone-sized viewport, 60 reaches all
 * five screens and absorbs both; 120 lost the last one.
 */
export const SWITCH_MARGIN_PX = 60

export function chooseActiveStep(centers: number[], mid: number, current: number): number {
  let best = -1
  let bestDist = Infinity
  centers.forEach((c, i) => {
    const d = Math.abs(c - mid)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  })
  if (best === -1) return current
  if (current < 0 || current >= centers.length || best === current) return best

  const currentDist = Math.abs(centers[current]! - mid)
  return bestDist + SWITCH_MARGIN_PX < currentDist ? best : current
}

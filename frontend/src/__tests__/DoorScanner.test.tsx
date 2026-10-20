/**
 * The staff camera, with the device replaced.
 *
 * jsdom has no camera, so `getUserMedia` and the browser's QR detector are
 * stand-ins. What is pinned is what a person at a door would otherwise find out
 * the hard way: which message they get when the camera is blocked or the page is
 * not https, that the camera is released when they leave, that a paused scanner
 * reads nothing, and that a phone without a built-in QR detector still scans.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import DoorScanner from '@/components/DoorScanner'

const jsqr = vi.hoisted(() => vi.fn<(...a: unknown[]) => { data: string } | null>(() => null))
vi.mock('jsqr', () => ({ default: (...a: unknown[]) => jsqr(...a) }))

const track = { stop: vi.fn() }
const stream = { getTracks: () => [track] } as unknown as MediaStream
let detections: string[] = []
let detectCalls = 0

function installCamera(over: { getUserMedia?: () => Promise<MediaStream>; detector?: boolean } = {}) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: over.getUserMedia ?? (async () => stream) },
  })
  Object.defineProperty(HTMLVideoElement.prototype, 'readyState', { configurable: true, get: () => 4 })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1280 })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 720 })
  HTMLVideoElement.prototype.play = vi.fn(async () => undefined)
  if (over.detector === false) {
    Reflect.deleteProperty(window, 'BarcodeDetector')
  } else {
    ;(window as unknown as Record<string, unknown>).BarcodeDetector = class {
      static async getSupportedFormats() {
        return ['qr_code']
      }
      async detect() {
        detectCalls += 1
        const next = detections.shift()
        return next ? [{ rawValue: next }] : []
      }
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  detections = []
  detectCalls = 0
  track.stop.mockReset()
  jsqr.mockReset()
  jsqr.mockReturnValue(null)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'BarcodeDetector')
  Reflect.deleteProperty(navigator, 'mediaDevices')
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
})

const renderScanner = (props: { onCode?: (t: string) => void; paused?: boolean } = {}) =>
  render(
    <StrictMode>
      <DoorScanner onCode={props.onCode ?? vi.fn()} paused={props.paused} />
    </StrictMode>,
  )

describe('DoorScanner', () => {
  it('reads a code with the browser\'s own detector and reports it', async () => {
    installCamera()
    detections = ['HWD1.abc.def']
    const onCode = vi.fn()
    renderScanner({ onCode })

    await vi.advanceTimersByTimeAsync(600)

    await waitFor(() => expect(onCode).toHaveBeenCalledWith('HWD1.abc.def'))
  })

  it('still scans on a phone with no built-in detector, by falling back to the JavaScript one', async () => {
    installCamera({ detector: false })
    const ctx = { drawImage: vi.fn(), getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })) }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    jsqr.mockReturnValue({ data: 'HWD1.fallback.code' })
    const onCode = vi.fn()
    renderScanner({ onCode })

    await vi.advanceTimersByTimeAsync(800)

    await waitFor(() => expect(onCode).toHaveBeenCalledWith('HWD1.fallback.code'))
    expect(jsqr).toHaveBeenCalled()
  })

  it('reads nothing while paused, and carries on when it is not', async () => {
    installCamera()
    detections = ['HWD1.a.b', 'HWD1.c.d', 'HWD1.e.f']
    const onCode = vi.fn()
    const { rerender } = renderScanner({ onCode, paused: true })

    await vi.advanceTimersByTimeAsync(800)
    expect(detectCalls).toBe(0)
    expect(onCode).not.toHaveBeenCalled()

    rerender(
      <StrictMode>
        <DoorScanner onCode={onCode} paused={false} />
      </StrictMode>,
    )
    await vi.advanceTimersByTimeAsync(800)
    await waitFor(() => expect(onCode).toHaveBeenCalled())
  })

  it('looks at frames at a bounded pace, not as fast as it can', async () => {
    installCamera()
    renderScanner()

    await vi.advanceTimersByTimeAsync(2_000)

    // ~160ms a tick: about a dozen in two seconds, nowhere near one per animation frame.
    expect(detectCalls).toBeLessThan(25)
  })

  it('says the camera is blocked, and what to do, when permission is refused', async () => {
    installCamera({ getUserMedia: async () => Promise.reject(new DOMException('no', 'NotAllowedError')) })
    renderScanner()

    expect(await screen.findByText(/camera access is blocked/i)).toBeTruthy()
  })

  it('says there is no camera when there is none', async () => {
    installCamera({ getUserMedia: async () => Promise.reject(new DOMException('none', 'NotFoundError')) })
    renderScanner()

    expect(await screen.findByText(/no camera was found/i)).toBeTruthy()
  })

  it('says the page needs https when the browser will not offer a camera at all', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
    renderScanner()

    expect(await screen.findByText(/secure \(https\) connection/i)).toBeTruthy()
  })

  it('lets go of the camera when staff leave', async () => {
    installCamera()
    const { unmount } = renderScanner()
    await vi.advanceTimersByTimeAsync(400)
    // StrictMode's discarded first mount releases ITS camera; count from here so
    // this measures leaving, not that.
    const before = track.stop.mock.calls.length

    unmount()

    expect(track.stop.mock.calls.length).toBeGreaterThan(before)
  })

  it('does not keep a camera that arrived after the screen was already closed', async () => {
    let resolve!: (s: MediaStream) => void
    installCamera({ getUserMedia: () => new Promise<MediaStream>((r) => (resolve = r)) })
    const { unmount } = renderScanner()
    unmount()

    resolve(stream)
    await vi.advanceTimersByTimeAsync(100)

    expect(track.stop).toHaveBeenCalled()
  })
})

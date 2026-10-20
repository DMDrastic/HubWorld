import { useEffect, useRef, useState } from 'react'

/** How often a frame is looked at. Fast enough to feel instant, slow enough not to cook a phone. */
const TICK_MS = 160

type Decoder = (video: HTMLVideoElement) => Promise<string | null>

/**
 * Something that reads a QR out of a video frame.
 *
 * The browser's own `BarcodeDetector` where it exists and can read QR codes: it
 * is native, fast and costs no bytes. Elsewhere (iPhone Safari is the one that
 * matters, since door staff use whatever phone they have) a JavaScript decoder,
 * loaded only then. Both are behind one function so nothing above cares which.
 */
async function makeDecoder(): Promise<Decoder> {
  const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  if (Detector) {
    try {
      const formats = (await Detector.getSupportedFormats?.()) ?? ['qr_code']
      if (formats.includes('qr_code')) {
        const detector = new Detector({ formats: ['qr_code'] })
        return async (video) => (await detector.detect(video))[0]?.rawValue ?? null
      }
    } catch {
      // Present but unusable: fall through to the JavaScript decoder.
    }
  }

  const { default: jsQR } = await import('jsqr')
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  return async (video) => {
    if (!ctx || !video.videoWidth) return null
    // Downscaled: a QR does not need a 4K frame, and decoding cost grows with pixels.
    const scale = Math.min(1, 640 / video.videoWidth)
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
    return jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })?.data ?? null
  }
}

type BarcodeDetectorCtor = {
  new (opts: { formats: string[] }): { detect: (src: CanvasImageSource) => Promise<Array<{ rawValue: string }>> }
  getSupportedFormats?: () => Promise<string[]>
}

/**
 * The staff's camera, reading codes.
 *
 * The only importer of the JavaScript QR decoder, loaded on demand like the
 * rest of the door: nobody pays for a scanner until they open one.
 *
 * It reports every code it sees, every tick. Deciding that the same code twice in
 * a row is one person, and that a verdict is in flight, is the caller's job: this
 * knows about cameras, not about the door.
 *
 * `getUserMedia` only works on a secure connection, so on plain http a phone
 * cannot scan at all. That is said in words, because "the camera does not start"
 * is a puzzle at a doorway.
 */
export default function DoorScanner({ onCode, paused = false }: { onCode: (text: string) => void; paused?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  // Latest values read inside the loop without restarting it (restarting the
  // camera on every render would flicker the preview and re-ask for permission).
  const onCodeRef = useRef(onCode)
  const pausedRef = useRef(paused)
  useEffect(() => {
    onCodeRef.current = onCode
    pausedRef.current = paused
  })

  useEffect(() => {
    let stopped = false
    let stream: MediaStream | null = null
    let timer: number | undefined

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setProblem(
          window.isSecureContext
            ? 'This browser cannot use the camera.'
            : 'The camera only works on a secure (https) connection.',
        )
        return
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })
      } catch (err) {
        if (stopped) return
        setProblem(
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Camera access is blocked. Allow it for this site in your browser settings, then reload.'
            : 'No camera was found on this device.',
        )
        return
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }

      const video = videoRef.current
      if (!video) return
      video.srcObject = stream
      await video.play().catch(() => undefined)
      const decode = await makeDecoder()
      if (stopped) return
      setReady(true)

      const tick = async () => {
        if (stopped) return
        try {
          if (!pausedRef.current && video.readyState >= 2) {
            const text = await decode(video)
            if (text && !stopped) onCodeRef.current(text)
          }
        } catch {
          // A frame that will not decode is just a frame.
        }
        if (!stopped) timer = window.setTimeout(() => void tick(), TICK_MS)
      }
      void tick()
    }

    void start()
    return () => {
      stopped = true
      window.clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  if (problem) {
    return (
      <p className="text-destructive rounded-xl border p-4 text-center text-sm" role="alert">
        {problem}
      </p>
    )
  }

  return (
    <div className="relative mx-auto aspect-square w-full max-w-72 overflow-hidden rounded-xl bg-black">
      <video ref={videoRef} playsInline muted className="size-full object-cover" aria-label="Camera" />
      {/* A frame to aim at; purely a guide, the whole picture is read. */}
      <div className="pointer-events-none absolute inset-6 rounded-lg border-2 border-white/70" aria-hidden />
      {!ready && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-white/80" role="status">
          Starting the camera…
        </p>
      )}
    </div>
  )
}

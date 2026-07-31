/**
 * Uploading an event's poster.
 *
 * Organizer-only, and specifically the organizer of THIS event — the same rule
 * minting follows. `requireOrganizer` alone would let any organizer overwrite
 * anyone else's artwork, which is defacement rather than a capability.
 *
 * The body is raw image bytes rather than multipart, so nothing has to parse a
 * form and no dependency is added. The client sends the file with its own
 * `Content-Type`; we ignore what it claims and read the bytes.
 */
import { Router } from 'express'
import express from 'express'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { prisma } from '../prisma.js'
import { storageMode } from '../env.js'
import { issuesOf, slugSchema } from '../schemas.js'
import { requireAuth, requireOrganizer } from '../session.js'
import { MAX_IMAGE_BYTES, checkImage, imageObjectPath } from '../image-upload.js'
import { StorageError, uploadPublicObject } from '../storage.js'

export const eventImageRouter = Router()

const SlugParams = z.object({ slug: slugSchema })

/**
 * POST /api/events/:slug/image
 *
 * Body: the raw image. `limit` is enforced here as well as in `checkImage`,
 * because refusing an oversized upload before it is buffered is cheaper than
 * reading it into memory first only to reject it.
 */
eventImageRouter.post(
  '/events/:slug/image',
  requireAuth,
  requireOrganizer,
  express.raw({ type: ['image/*'], limit: MAX_IMAGE_BYTES }),
  async (req, res) => {
    const params = SlugParams.safeParse(req.params)
    if (!params.success) {
      res.status(400).json({ error: 'Invalid event slug', details: issuesOf(params.error) })
      return
    }

    if (storageMode === 'disabled') {
      // Deliberately 503 rather than 500: nothing is broken, the deployment
      // simply has no bucket configured, and the message should say so.
      res.status(503).json({
        error: 'Image upload is unavailable: object storage is not configured',
      })
      return
    }

    const event = await prisma.event.findUnique({ where: { slug: params.data.slug } })
    if (!event) {
      res.status(404).json({ error: 'Event not found' })
      return
    }
    // Being AN organizer is not enough — this must be THIS event's organizer.
    if (event.organizerId !== req.userId) {
      res.status(403).json({ error: 'Only the event organizer can change its image' })
      return
    }

    // express.raw leaves a Buffer, or an empty object when nothing matched the
    // type filter — which is what a wrong Content-Type looks like from here.
    const body: unknown = req.body
    if (!Buffer.isBuffer(body)) {
      res.status(400).json({ error: 'Send the image as the raw request body with an image/* type' })
      return
    }

    const verdict = checkImage(new Uint8Array(body), req.get('content-type'))
    if (!verdict.ok) {
      res.status(400).json({ error: verdict.reason })
      return
    }

    const path = imageObjectPath(event.id, verdict.ext, randomBytes(8).toString('hex'))

    let imageUrl: string
    try {
      imageUrl = await uploadPublicObject(path, new Uint8Array(body), verdict.mime)
    } catch (err) {
      if (err instanceof StorageError) {
        res.status(502).json({ error: err.message })
        return
      }
      throw err
    }

    // Written only after the object exists. The reverse order would leave the
    // event pointing at a URL that 404s if the upload failed.
    const updated = await prisma.event.update({
      where: { id: event.id },
      data: { imageUrl },
      select: { slug: true, imageUrl: true },
    })

    // The previous object is deliberately NOT deleted. It costs a few KB, and a
    // failed delete must never make a successful upload look broken — the same
    // best-effort reasoning settlement uses for cancelling losing offers.
    res.status(201).json(updated)
  },
)

/**
 * The server's public policy, available wherever a signing screen needs to check something against it.
 *
 * The approve screen checks an offer against HubWorld's broker account as the server's policy reports it, read separately
 * from the request being reviewed. Passing that down by hand through every dialog would be a prop on a dozen components, so
 * the app provides it once. Empty (null) means it has not loaded or could not be read, which the review treats as "cannot
 * confirm", never as "fine".
 */
import { createContext, useContext } from 'react'
import type { Policy } from '@/lib/api'

export const PolicyContext = createContext<Policy | null>(null)

export function usePolicy(): Policy | null {
  return useContext(PolicyContext)
}

/**
 * Where the review module is fetched from.
 *
 * The review needs the XRPL codec, which is large, so it is imported on demand rather than at the
 * top of any component: only someone approving with their own wallet ever loads it. Held on an
 * object so a test can replace `load` directly; mocking a dynamic import by path is not reliable
 * across bundlers.
 */
export const reviewer = {
  load: () => import('@/lib/sign-review'),
}

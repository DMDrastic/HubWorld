import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Unmount between tests so a leaked polling timer from one test cannot fire
// into the next and make failures look random.
afterEach(() => {
  cleanup()
})

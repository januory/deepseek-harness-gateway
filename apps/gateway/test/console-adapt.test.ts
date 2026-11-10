import { describe, expect, it } from 'vitest'
import { injectMobileAdapt } from '../src/console-adapt.js'

describe('mobile console adaptation', () => {
  it('does not inject a floating sidebar toggle', () => {
    const html = injectMobileAdapt('<html><head></head><body><div id="app"></div></body></html>')

    expect(html).not.toContain('dshGwMobileFab')
  })
})

// lib/page-state.js
//
// Detects blocking UI state (overlays, modals, dropdowns) on the current page.
// Plain helper functions — no classes.

async function capturePageState(page) {
  return await page.evaluate(() => {
    const state = {
      overlays: [],
      openModals: [],
      openDropdowns: [],
    }

    document.querySelectorAll('*').forEach(el => {
      const style = getComputedStyle(el)
      const rect = el.getBoundingClientRect()

      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0

      if (!visible) return

      const blocksPointer = style.pointerEvents !== 'none'

      if ((style.position === 'fixed' || style.position === 'absolute') && blocksPointer) {
        const coversPage =
          rect.width >= window.innerWidth * 0.8 &&
          rect.height >= window.innerHeight * 0.8 &&
          parseInt(style.zIndex || '0', 10) > 0

        if (coversPage) {
          state.overlays.push({
            selector: minSelector(el),
            zIndex: parseInt(style.zIndex || '0', 10),
            coversFullPage: true,
          })
        }
      }
    })

    document.querySelectorAll('[role="dialog"], dialog[open], [aria-modal="true"]').forEach(el => {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') return
      state.openModals.push({
        selector: minSelector(el),
        title: el.querySelector('h1, h2, h3, [role="heading"]')?.textContent?.trim() || '',
        hasBackdrop: !!document.querySelector('.fixed.inset-0, [class*="backdrop"], [class*="overlay"]'),
      })
    })

    document.querySelectorAll('[aria-expanded="true"], [data-state="open"]').forEach(el => {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') return
      state.openDropdowns.push({
        selector: minSelector(el),
        triggerText: el.textContent?.trim()?.slice(0, 60) || '',
        mayBlock: !!document.querySelector('.fixed.inset-0, [class*="backdrop"], [class*="overlay"]'),
      })
    })

    return state

    function minSelector(el) {
      if (el.id) return `#${el.id}`
      const testId = el.getAttribute('data-testid')
      if (testId) return `[data-testid="${testId}"]`
      const role = el.getAttribute('role')
      if (role) return `[role="${role}"]`
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
      return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase()
    }
  })
}

function hasBlockingOverlay(state) {
  return state.overlays.some(o => o.coversFullPage) ||
    state.openModals.some(m => m.hasBackdrop) ||
    state.openDropdowns.some(d => d.mayBlock)
}

function getBlockingElement(state) {
  if (state.openModals.length > 0) return { type: 'modal', ...state.openModals.at(-1) }
  if (state.overlays.length > 0) return { type: 'overlay', ...state.overlays.at(-1) }
  if (state.openDropdowns.length > 0) return { type: 'dropdown', ...state.openDropdowns.at(-1) }
  return null
}

async function dismissBlockingOverlays(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await capturePageState(page)
    if (!hasBlockingOverlay(before)) return true

    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(400)

    const afterEscape = await capturePageState(page)
    if (!hasBlockingOverlay(afterEscape)) return true

    try {
      const backdrop = page.locator('.fixed.inset-0, [class*="backdrop"], [class*="overlay"]').first()
      if (await backdrop.count() > 0) {
        await backdrop.click({ force: true })
        await page.waitForTimeout(400)
      }
    } catch {}

    const afterClick = await capturePageState(page)
    if (!hasBlockingOverlay(afterClick)) return true
  }

  return false
}

module.exports = {
  capturePageState,
  hasBlockingOverlay,
  getBlockingElement,
  dismissBlockingOverlays,
}

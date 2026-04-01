// lib/action-executor.js
//
// Minimal action executor for flow validation.
// Mirrors the action types in run-e2e.js but without selector healing.
// Used by lib/flow-validator.js.

const { resolveValue } = require("./resolve-value")

async function executeRecordedAction(page, action, cfg) {
  const value = resolveValue(action.value, cfg)
  const timeout = cfg.timeout || 10000

  switch (action.type) {
    case "fill":
      await page.locator(action.selector).first().fill(value, { timeout })
      return

    case "click":
      await page.locator(action.selector).first().click({ timeout })
      return

    case "submit":
      await page.locator(action.selector).first().click({ timeout })
      return

    case "press":
      if (action.selector) {
        await page.locator(action.selector).first().press(action.key, { timeout })
      } else {
        await page.keyboard.press(action.key)
      }
      return

    case "waitForURL":
      await page.waitForURL(`**${value}`, { timeout })
      return

    case "select": {
      const triggerSelector = action.triggerSelector || action.selector
      const trigger = page.locator(triggerSelector).first()

      // Check for native <select>
      const tagName = await trigger.evaluate(el => el.tagName).catch(() => "")
      if (tagName === "SELECT") {
        await trigger.selectOption({ index: (action.position || 1) - 1 }, { timeout })
        return
      }

      // Custom dropdown — click trigger, then pick by position
      await trigger.click({ timeout })
      await page.waitForTimeout(300)

      const options = page.locator('[role="option"], [role="menuitem"], [role="listbox"] li, [cmdk-item], [data-value]')
      const count = await options.count()
      if (count === 0) throw new Error(`No dropdown options found for "${triggerSelector}"`)

      const index = Math.min(Math.max((action.position || 1) - 1, 0), count - 1)
      await options.nth(index).click({ timeout })
      return
    }

    case "hover":
      await page.locator(action.selector).first().hover({ timeout })
      return

    default:
      throw new Error(`Unsupported validation action type: ${action.type}`)
  }
}

module.exports = { executeRecordedAction }

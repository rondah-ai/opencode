// lib/resolve-value.js
//
// Shared variable resolver for $EMAIL, $PASSWORD, and custom vars.
// Used by run-e2e.js and lib/action-executor.js.

function resolveValue(value, cfg) {
  if (typeof value !== 'string') return value

  let resolved = value
  resolved = resolved.replace(/\$EMAIL/g, cfg.email || '')
  resolved = resolved.replace(/\$PASSWORD/g, cfg.password || '')

  for (const [key, val] of Object.entries(cfg.vars || {})) {
    resolved = resolved.replace(new RegExp(`\\$${key}`, 'g'), val)
  }

  return resolved
}

module.exports = { resolveValue }

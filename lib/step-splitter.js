// lib/step-splitter.js
//
// Splits a batch of pending events into groups at navigation boundaries.
// Each group becomes its own recorded step.

/**
 * Splits events at navigation boundaries.
 * A boundary is a "navigation" event or a "_urlChanged" tagged event.
 * Returns array of event groups. Returns [events] unchanged if no split needed.
 */
function splitOnNavigation(events) {
  if (!events || events.length <= 1) return [events]

  const groups = []
  let current = []

  for (const ev of events) {
    current.push(ev)
    if (ev.type === "navigation" || ev._urlChanged) {
      groups.push(current)
      current = []
    }
  }

  if (current.length > 0) groups.push(current)
  return groups.length > 1 ? groups : [events]
}

/**
 * Finds the snapshot for a group by walking backward to find the nearest
 * _snapshotAfter attached to a navigation event in this group.
 * Falls back to the provided fallback snapshot.
 */
function getGroupSnapshot(group, fallbackSnapshot) {
  for (let i = group.length - 1; i >= 0; i--) {
    if (group[i]._snapshotAfter) return group[i]._snapshotAfter
  }
  return fallbackSnapshot
}

/**
 * Finds the route for a group by looking at navigation events and snapshots.
 * Checks both explicit navigation events and _snapshotAfter from SPA transitions.
 * Falls back to the provided fallback route.
 */
function getGroupRoute(group, fallbackRoute) {
  // Walk backward to find the most recent route signal
  for (let i = group.length - 1; i >= 0; i--) {
    // Explicit navigation event with URL
    if (group[i].type === "navigation" && group[i].url) {
      try {
        return new URL(group[i].url).pathname
      } catch {}
    }
    // SPA transition captured via _snapshotAfter (has .route from captureState)
    if (group[i]._snapshotAfter && group[i]._snapshotAfter.route) {
      return group[i]._snapshotAfter.route
    }
  }
  return fallbackRoute
}

module.exports = {
  splitOnNavigation,
  getGroupSnapshot,
  getGroupRoute,
}

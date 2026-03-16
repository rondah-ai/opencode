import z from "zod"
import fs from "fs/promises"

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const VerifyCheckSchema = z.object({
  type: z.enum([
    "element_count_changed",
    "element_appeared",
    "element_disappeared",
    "text_appeared",
    "text_disappeared",
    "url_changed",
    "no_errors",
    "toast_appeared",
    "count_equals",
    "custom_selector_visible",
    "custom_selector_hidden",
  ]),
  selector: z.string().optional(),
  value: z.string().optional(),
})

export const CapabilitySchema = z.object({
  description: z.string().optional(),
  preconditions: z.array(z.string()).default([]),
  interaction: z.string(),
  expected: z.array(z.string()),
  verify: z.array(VerifyCheckSchema).default([]),
  cleanup: z.string().optional(),
  edge_cases: z.array(z.string()).optional(),
  confidence: z
    .enum(["init", "migrated", "observed_1x", "observed_2x", "observed_3x", "stable", "edge_cased"])
    .optional(),
})

export const FeatureSchema = z.object({
  description: z.string(),
  route: z.string(),
  requires: z.array(z.string()).default([]),
  capabilities: z.record(z.string(), CapabilitySchema),
  test_data: z.record(z.string(), z.any()).optional(),
})

export const SharedCapabilitySchema = z.object({
  how: z.string(),
  verify: z.string(),
  route: z.string().optional(),
})

export const FeatureModelSchema = z.object({
  version: z.string(),
  features: z.record(z.string(), FeatureSchema),
  shared: z.record(z.string(), SharedCapabilitySchema).default({}),
  test_data: z.record(z.string(), z.any()).optional(),
})

export type Capability = z.infer<typeof CapabilitySchema>
export type Feature = z.infer<typeof FeatureSchema>
export type SharedCapability = z.infer<typeof SharedCapabilitySchema>
export type FeatureModel = z.infer<typeof FeatureModelSchema>

// ─── Cache ───────────────────────────────────────────────────────────────────

let cachedModel: FeatureModel | null = null
let cachedModelPath: string | null = null

export function getFeatureModel(): FeatureModel | null {
  return cachedModel
}

export function clearFeatureModel(): void {
  cachedModel = null
  cachedModelPath = null
}

// ─── Loader ──────────────────────────────────────────────────────────────────

export async function loadFeatureModel(filePath: string): Promise<FeatureModel> {
  const content = await fs.readFile(filePath, "utf-8")
  let raw: unknown

  try {
    raw = JSON.parse(content)
  } catch {
    throw new Error(`Invalid JSON in feature model: ${filePath}`)
  }

  const result = FeatureModelSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n")
    throw new Error(`Feature model validation failed:\n${issues}`)
  }

  cachedModel = result.data
  cachedModelPath = filePath
  return result.data
}

// ─── Dependency Resolution ───────────────────────────────────────────────────

export interface ResolvedCapability {
  feature: string
  capability: string
  route: string
  interaction: string
  expected: string[]
  verify: z.infer<typeof VerifyCheckSchema>[]
  testData?: Record<string, unknown>
  cleanup?: string
  edgeCases?: string[]
  isShared: boolean
}

/**
 * Resolve requested features into an ordered list of capabilities,
 * respecting feature-level `requires` and capability-level `preconditions`.
 */
export function resolveCapabilities(
  model: FeatureModel,
  requestedFeatures: string[],
): ResolvedCapability[] {
  // Validate requested features exist
  for (const name of requestedFeatures) {
    if (!model.features[name] && !model.shared[name]) {
      const available = [
        ...Object.keys(model.features),
        ...Object.keys(model.shared),
      ]
      throw new Error(
        `Unknown feature: "${name}". Available: ${available.join(", ")}`,
      )
    }
  }

  // Step 1: Topological sort of features (respecting `requires`)
  const sortedFeatures = topologicalSortFeatures(model.features, requestedFeatures)

  // Step 2: For each feature, resolve capabilities in precondition order
  const resolved: ResolvedCapability[] = []
  const emittedShared = new Set<string>()

  for (const featureName of sortedFeatures) {
    const feature = model.features[featureName]
    if (!feature) continue

    // Emit shared dependencies first
    for (const req of feature.requires) {
      if (model.shared[req] && !emittedShared.has(req)) {
        emittedShared.add(req)
        const shared = model.shared[req]
        resolved.push({
          feature: "shared",
          capability: req,
          route: shared.route ?? "",
          interaction: shared.how,
          expected: [shared.verify],
          verify: [],
          isShared: true,
        })
      }
    }

    // Resolve capabilities within this feature in precondition order
    const sortedCaps = topologicalSortCapabilities(feature.capabilities)

    for (const capName of sortedCaps) {
      const cap = feature.capabilities[capName]
      if (!cap) continue

      resolved.push({
        feature: featureName,
        capability: capName,
        route: feature.route,
        interaction: cap.interaction,
        expected: cap.expected,
        verify: cap.verify,
        testData: feature.test_data,
        cleanup: cap.cleanup,
        edgeCases: cap.edge_cases,
        isShared: false,
      })
    }
  }

  return resolved
}

/**
 * Topological sort of features based on `requires` field.
 * Detects circular dependencies.
 */
function topologicalSortFeatures(
  features: FeatureModel["features"],
  requested: string[],
): string[] {
  const visited = new Set<string>()
  const visiting = new Set<string>() // for cycle detection
  const sorted: string[] = []

  function visit(name: string, path: string[]) {
    if (visited.has(name)) return
    if (visiting.has(name)) {
      throw new Error(
        `Circular dependency detected: ${[...path, name].join(" → ")}`,
      )
    }

    visiting.add(name)
    const feature = features[name]
    if (feature) {
      for (const dep of feature.requires) {
        // Only visit feature-level deps (not shared)
        if (features[dep]) {
          visit(dep, [...path, name])
        }
      }
    }
    visiting.delete(name)
    visited.add(name)
    sorted.push(name)
  }

  for (const name of requested) {
    if (features[name]) {
      visit(name, [])
    }
  }

  return sorted
}

/**
 * Topological sort of capabilities within a feature based on `preconditions`.
 * Preconditions reference other capability names within the same feature.
 */
function topologicalSortCapabilities(
  capabilities: Record<string, Capability>,
): string[] {
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const sorted: string[] = []

  function visit(name: string, path: string[]) {
    if (visited.has(name)) return
    if (visiting.has(name)) {
      throw new Error(
        `Circular capability dependency: ${[...path, name].join(" → ")}`,
      )
    }

    visiting.add(name)
    const cap = capabilities[name]
    if (cap) {
      for (const pre of cap.preconditions) {
        if (capabilities[pre]) {
          visit(pre, [...path, name])
        }
      }
    }
    visiting.delete(name)
    visited.add(name)
    sorted.push(name)
  }

  for (const name of Object.keys(capabilities)) {
    visit(name, [])
  }

  return sorted
}

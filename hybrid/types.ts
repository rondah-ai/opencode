/**
 * Hybrid QA Agent Types
 * Option C: Hybrid with Learning
 */

export interface Step {
  action: string;
  selector?: string;
  target?: string;
  value?: string;
  url?: string;
  description?: string;
  wait?: number;
  verify?: string;
}

export interface Flow {
  name: string;
  path: string;
  suite?: string;
  steps: Step[];
}

export interface ExecutionContext {
  flowPath: string;
  url: string;
  pageType: string;
  screenshot?: Buffer;
  dom?: string;
  viewport?: { width: number; height: number };
}

export interface Solution {
  id: string;
  flowPath: string;
  stepAction: string;
  originalSelector: string;
  learnedSelector: string;
  confidence: number;
  successCount: number;
  failureCount: number;
  pageContext: {
    url: string;
    pageType: string;
  };
  learnedAt: string;
  lastUsed: string;
}

export interface Pattern {
  id: string;
  type: 'selector-transformation' | 'timing' | 'navigation' | 'verification';
  from?: string;
  to?: string;
  confidence: number;
  applicablePages: string[];
  examples?: Array<{ from: string; to: string }>;
  successRate?: number;
  waitBefore?: number;
  reason?: string;
}

export interface ExecutionResult {
  success: boolean;
  method: 'deterministic' | 'learned' | 'ai';
  actualSelector?: string;
  duration: number;
  error?: Error;
  screenshot?: string;
  needsLearning?: boolean;
}

export interface AIResponse {
  selector: string;
  strategy: string;
  confidence: number;
  reasoning: string;
  alternatives?: string[];
}

export interface KnowledgeBaseData {
  version: string;
  lastUpdated: string;
  solutions: Solution[];
}

export interface PatternsData {
  version: string;
  lastUpdated: string;
  patterns: Pattern[];
}

// ─── Smart QA Knowledge Types ────────────────────────────────────────────────

export interface PatternKnowledge {
  route: string
  patterns: {
    type: string
    confidence: number
    rootSelector: string
    signalHits: number
    totalSignals: number
  }[]
  smokeResults?: {
    pattern: string
    checks: { name: string; passed: boolean }[]
  }[]
  lastScanned: string
  scanCount: number
}

export interface FeatureKnowledge {
  feature: string
  capability: string
  lastTested: string
  result: "passed" | "failed"
  duration: number
  verifyChecks: { type: string; passed: boolean; detail: string }[]
  testCount: number
  passRate: number
}

export interface SelectorKnowledge {
  original: string
  fallback: string
  page: string
  lastUsed: string
  successCount: number
  failureCount: number
  successRate: number
}

export interface SmartKnowledgeData {
  version: string
  lastUpdated: string
  pagePatterns: PatternKnowledge[]
  featureResults: FeatureKnowledge[]
  selectorFallbacks: SelectorKnowledge[]
}

export interface StatsData {
  version: string;
  lastUpdated: string;
  analytics: {
    totalRuns: number;
    totalSteps: number;
    deterministicSuccess: number;
    learnedSuccess: number;
    aiRequired: number;
    aiCost: {
      total: number;
      average: number;
      trend: string;
    };
    timing: {
      avgExecutionTime: number;
      avgDeterministicTime: number;
      avgAITime: number;
    };
    learning: {
      patternsLearned: number;
      solutionsStored: number;
      avgConfidence: number;
    };
  };
  byWeek?: Record<string, {
    runs: number;
    aiUsagePercent: number;
    avgCost: number;
  }>;
}

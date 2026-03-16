/**
 * Knowledge Base Manager
 * Manages learned solutions and patterns
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type {
  Solution,
  Pattern,
  Step,
  ExecutionContext,
  KnowledgeBaseData,
  PatternsData,
  StatsData,
  PatternKnowledge,
  FeatureKnowledge,
  SelectorKnowledge,
  SmartKnowledgeData,
} from './types.js';

export class KnowledgeBaseManager {
  private basePath: string;
  private solutions: Map<string, Solution>;
  private patterns: Map<string, Pattern>;
  private stats: StatsData;

  // Smart QA knowledge
  private pagePatterns: Map<string, PatternKnowledge>;
  private featureResults: Map<string, FeatureKnowledge>;
  private selectorFallbacks: Map<string, SelectorKnowledge>;

  constructor(repoRoot: string) {
    this.basePath = path.join(repoRoot, '.opencode', 'qa-knowledge');
    this.solutions = new Map();
    this.patterns = new Map();
    this.stats = this.initStats();
    this.pagePatterns = new Map();
    this.featureResults = new Map();
    this.selectorFallbacks = new Map();
    this.ensureDirectories();
    this.load();
  }

  private ensureDirectories(): void {
    const dirs = [
      this.basePath,
      path.join(this.basePath, 'cache'),
      path.join(this.basePath, 'cache', 'page-contexts'),
      path.join(this.basePath, 'cache', 'ai-responses'),
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  private initStats(): StatsData {
    return {
      version: '1.0',
      lastUpdated: new Date().toISOString(),
      analytics: {
        totalRuns: 0,
        totalSteps: 0,
        deterministicSuccess: 0,
        learnedSuccess: 0,
        aiRequired: 0,
        aiCost: {
          total: 0,
          average: 0,
          trend: 'stable',
        },
        timing: {
          avgExecutionTime: 0,
          avgDeterministicTime: 0,
          avgAITime: 0,
        },
        learning: {
          patternsLearned: 0,
          solutionsStored: 0,
          avgConfidence: 0,
        },
      },
      byWeek: {},
    };
  }

  private load(): void {
    // Load solutions
    const solutionsPath = path.join(this.basePath, 'solutions.json');
    if (fs.existsSync(solutionsPath)) {
      try {
        const data: KnowledgeBaseData = JSON.parse(fs.readFileSync(solutionsPath, 'utf-8'));
        this.solutions = new Map(data.solutions.map(s => [s.id, s]));
        console.log(`[Knowledge] Loaded ${this.solutions.size} solutions`);
      } catch (error) {
        console.warn('[Knowledge] Failed to load solutions:', error);
      }
    }

    // Load patterns
    const patternsPath = path.join(this.basePath, 'patterns.json');
    if (fs.existsSync(patternsPath)) {
      try {
        const data: PatternsData = JSON.parse(fs.readFileSync(patternsPath, 'utf-8'));
        this.patterns = new Map(data.patterns.map(p => [p.id, p]));
        console.log(`[Knowledge] Loaded ${this.patterns.size} patterns`);
      } catch (error) {
        console.warn('[Knowledge] Failed to load patterns:', error);
      }
    }

    // Load stats
    const statsPath = path.join(this.basePath, 'stats.json');
    if (fs.existsSync(statsPath)) {
      try {
        this.stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
      } catch (error) {
        console.warn('[Knowledge] Failed to load stats:', error);
      }
    }

    // Load smart knowledge
    const smartPath = path.join(this.basePath, 'smart-knowledge.json');
    if (fs.existsSync(smartPath)) {
      try {
        const data: SmartKnowledgeData = JSON.parse(fs.readFileSync(smartPath, 'utf-8'));
        this.pagePatterns = new Map(data.pagePatterns.map(p => [p.route, p]));
        this.featureResults = new Map(data.featureResults.map(f => [`${f.feature}.${f.capability}`, f]));
        this.selectorFallbacks = new Map(data.selectorFallbacks.map(s => [`${s.page}:${s.original}`, s]));
        console.log(`[Knowledge] Loaded ${this.pagePatterns.size} page patterns, ${this.featureResults.size} feature results, ${this.selectorFallbacks.size} selector fallbacks`);
      } catch (error) {
        console.warn('[Knowledge] Failed to load smart knowledge:', error);
      }
    }
  }

  async save(): Promise<void> {
    // Save solutions
    const solutionsPath = path.join(this.basePath, 'solutions.json');
    const solutionsData: KnowledgeBaseData = {
      version: '1.0',
      lastUpdated: new Date().toISOString(),
      solutions: Array.from(this.solutions.values()),
    };
    fs.writeFileSync(solutionsPath, JSON.stringify(solutionsData, null, 2));

    // Save patterns
    const patternsPath = path.join(this.basePath, 'patterns.json');
    const patternsData: PatternsData = {
      version: '1.0',
      lastUpdated: new Date().toISOString(),
      patterns: Array.from(this.patterns.values()),
    };
    fs.writeFileSync(patternsPath, JSON.stringify(patternsData, null, 2));

    // Save stats
    const statsPath = path.join(this.basePath, 'stats.json');
    this.stats.lastUpdated = new Date().toISOString();
    fs.writeFileSync(statsPath, JSON.stringify(this.stats, null, 2));

    // Save smart knowledge
    const smartPath = path.join(this.basePath, 'smart-knowledge.json');
    const smartData: SmartKnowledgeData = {
      version: '1.0',
      lastUpdated: new Date().toISOString(),
      pagePatterns: Array.from(this.pagePatterns.values()),
      featureResults: Array.from(this.featureResults.values()),
      selectorFallbacks: Array.from(this.selectorFallbacks.values()),
    };
    fs.writeFileSync(smartPath, JSON.stringify(smartData, null, 2));
  }

  /**
   * Find a learned solution for a step
   */
  async findSolution(step: Step, context: ExecutionContext): Promise<Solution | null> {
    const key = this.generateKey(step);
    const exact = this.solutions.get(key);

    // Return exact match if confidence is high
    if (exact && exact.confidence > 0.8) {
      return exact;
    }

    // Try finding similar solutions
    for (const solution of this.solutions.values()) {
      if (
        solution.stepAction === step.action &&
        solution.pageContext.pageType === context.pageType &&
        solution.confidence > 0.75
      ) {
        // Check if selectors are similar
        const similarity = this.selectorSimilarity(
          step.selector || step.target || '',
          solution.originalSelector
        );
        if (similarity > 0.8) {
          return solution;
        }
      }
    }

    // Try pattern matching
    for (const pattern of this.patterns.values()) {
      if (this.patternMatches(pattern, step, context)) {
        return this.applyPattern(pattern, step);
      }
    }

    return null;
  }

  /**
   * Record a new solution learned from AI
   */
  async recordSolution(
    step: Step,
    actualSelector: string,
    context: ExecutionContext
  ): Promise<void> {
    const solution: Solution = {
      id: this.generateKey(step),
      flowPath: context.flowPath,
      stepAction: step.action,
      originalSelector: step.selector || step.target || '',
      learnedSelector: actualSelector,
      confidence: 0.7, // Initial confidence
      successCount: 1,
      failureCount: 0,
      pageContext: {
        url: context.url,
        pageType: context.pageType,
      },
      learnedAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
    };

    this.solutions.set(solution.id, solution);
    this.stats.analytics.learning.solutionsStored = this.solutions.size;
    await this.save();

    console.log(`[Knowledge] Learned new solution: ${solution.learnedSelector}`);
  }

  /**
   * Record successful use of a solution
   */
  async recordSuccess(solutionId: string): Promise<void> {
    const solution = this.solutions.get(solutionId);
    if (solution) {
      solution.successCount++;
      solution.lastUsed = new Date().toISOString();
      solution.confidence = Math.min(0.99, solution.confidence + 0.02);
      await this.save();
    }
  }

  /**
   * Record failed use of a solution
   */
  async recordFailure(solutionId: string): Promise<void> {
    const solution = this.solutions.get(solutionId);
    if (solution) {
      solution.failureCount++;
      solution.confidence = Math.max(0.3, solution.confidence - 0.1);

      // Remove if confidence too low
      if (solution.confidence < 0.4) {
        console.log(`[Knowledge] Removing low-confidence solution: ${solutionId}`);
        this.solutions.delete(solutionId);
      }

      await this.save();
    }
  }

  /**
   * Update statistics
   */
  async updateStats(method: 'deterministic' | 'learned' | 'ai', duration: number, cost?: number): Promise<void> {
    this.stats.analytics.totalSteps++;

    switch (method) {
      case 'deterministic':
        this.stats.analytics.deterministicSuccess++;
        break;
      case 'learned':
        this.stats.analytics.learnedSuccess++;
        break;
      case 'ai':
        this.stats.analytics.aiRequired++;
        if (cost) {
          this.stats.analytics.aiCost.total += cost;
          this.stats.analytics.aiCost.average =
            this.stats.analytics.aiCost.total / this.stats.analytics.aiRequired;
        }
        break;
    }

    // Update timing
    const total = this.stats.analytics.totalSteps;
    const currentAvg = this.stats.analytics.timing.avgExecutionTime;
    this.stats.analytics.timing.avgExecutionTime = (currentAvg * (total - 1) + duration) / total;

    await this.save();
  }

  /**
   * Get statistics
   */
  getStats(): StatsData {
    return this.stats;
  }

  /**
   * Get AI usage percentage
   */
  getAIUsagePercent(): number {
    const total = this.stats.analytics.totalSteps;
    if (total === 0) return 100;
    return (this.stats.analytics.aiRequired / total) * 100;
  }

  // ─── Smart QA Knowledge: Page Patterns ────────────────────────────────────

  /**
   * Store pattern scan results for a page (called after map_site/scan_page)
   */
  async recordPagePatterns(
    route: string,
    patterns: { type: string; confidence: number; rootSelector: string; signalHits: number; totalSignals: number }[],
    smokeResults?: { pattern: string; checks: { name: string; passed: boolean }[] }[],
  ): Promise<void> {
    const existing = this.pagePatterns.get(route);
    const entry: PatternKnowledge = {
      route,
      patterns,
      smokeResults,
      lastScanned: new Date().toISOString(),
      scanCount: (existing?.scanCount ?? 0) + 1,
    };
    this.pagePatterns.set(route, entry);
    await this.save();
  }

  /**
   * Get cached patterns for a route. Returns null if never scanned or stale.
   */
  getPagePatterns(route: string, maxAgeMs = 24 * 60 * 60 * 1000): PatternKnowledge | null {
    const entry = this.pagePatterns.get(route);
    if (!entry) return null;

    const age = Date.now() - new Date(entry.lastScanned).getTime();
    if (age > maxAgeMs) return null;

    return entry;
  }

  /**
   * Check if a page's patterns have changed since last scan
   */
  havePatternsChanged(
    route: string,
    currentPatterns: { type: string; confidence: number }[],
  ): boolean {
    const cached = this.pagePatterns.get(route);
    if (!cached) return true;

    if (cached.patterns.length !== currentPatterns.length) return true;

    const cachedTypes = new Set(cached.patterns.map(p => p.type));
    const currentTypes = new Set(currentPatterns.map(p => p.type));
    for (const t of currentTypes) {
      if (!cachedTypes.has(t)) return true;
    }

    return false;
  }

  // ─── Smart QA Knowledge: Feature Test Results ───────────────────────────

  /**
   * Store a capability test result (called after verify_behavior)
   */
  async recordFeatureResult(
    feature: string,
    capability: string,
    result: 'passed' | 'failed',
    duration: number,
    verifyChecks: { type: string; passed: boolean; detail: string }[],
  ): Promise<void> {
    const key = `${feature}.${capability}`;
    const existing = this.featureResults.get(key);
    const testCount = (existing?.testCount ?? 0) + 1;
    const prevPassCount = existing ? Math.round(existing.passRate * existing.testCount) : 0;
    const passCount = prevPassCount + (result === 'passed' ? 1 : 0);

    const entry: FeatureKnowledge = {
      feature,
      capability,
      lastTested: new Date().toISOString(),
      result,
      duration,
      verifyChecks,
      testCount,
      passRate: passCount / testCount,
    };
    this.featureResults.set(key, entry);
    await this.save();
  }

  /**
   * Get last test result for a capability
   */
  getFeatureResult(feature: string, capability: string): FeatureKnowledge | null {
    return this.featureResults.get(`${feature}.${capability}`) ?? null;
  }

  /**
   * Get all features that failed in the last run
   */
  getFailedFeatures(): FeatureKnowledge[] {
    return Array.from(this.featureResults.values()).filter(f => f.result === 'failed');
  }

  /**
   * Get features sorted by failure rate (most flaky first)
   */
  getFlakyFeatures(minTests = 3): FeatureKnowledge[] {
    return Array.from(this.featureResults.values())
      .filter(f => f.testCount >= minTests && f.passRate < 1.0)
      .sort((a, b) => a.passRate - b.passRate);
  }

  // ─── Smart QA Knowledge: Selector Fallbacks ─────────────────────────────

  /**
   * Store a selector fallback (called after resolve_selector finds alternative)
   */
  async recordSelectorFallback(
    page: string,
    original: string,
    fallback: string,
  ): Promise<void> {
    const key = `${page}:${original}`;
    const existing = this.selectorFallbacks.get(key);

    const entry: SelectorKnowledge = {
      original,
      fallback,
      page,
      lastUsed: new Date().toISOString(),
      successCount: (existing?.successCount ?? 0) + 1,
      failureCount: existing?.failureCount ?? 0,
      successRate: 1.0,
    };
    entry.successRate = entry.successCount / (entry.successCount + entry.failureCount);
    this.selectorFallbacks.set(key, entry);
    await this.save();
  }

  /**
   * Get a known fallback selector for a page
   */
  getSelectorFallback(page: string, original: string): string | null {
    const entry = this.selectorFallbacks.get(`${page}:${original}`);
    if (!entry || entry.successRate < 0.5) return null;
    return entry.fallback;
  }

  /**
   * Record that a fallback selector failed
   */
  async recordSelectorFailure(page: string, original: string): Promise<void> {
    const key = `${page}:${original}`;
    const entry = this.selectorFallbacks.get(key);
    if (entry) {
      entry.failureCount++;
      entry.successRate = entry.successCount / (entry.successCount + entry.failureCount);

      // Remove if success rate drops too low
      if (entry.successRate < 0.3) {
        this.selectorFallbacks.delete(key);
      }

      await this.save();
    }
  }

  // ─── Smart QA Knowledge: Pruning ────────────────────────────────────────

  /**
   * Prune old knowledge entries to prevent unbounded growth
   */
  async prune(maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<{ removed: number }> {
    let removed = 0;
    const cutoff = Date.now() - maxAgeMs;

    for (const [key, entry] of this.pagePatterns) {
      if (new Date(entry.lastScanned).getTime() < cutoff) {
        this.pagePatterns.delete(key);
        removed++;
      }
    }

    for (const [key, entry] of this.featureResults) {
      if (new Date(entry.lastTested).getTime() < cutoff) {
        this.featureResults.delete(key);
        removed++;
      }
    }

    for (const [key, entry] of this.selectorFallbacks) {
      if (new Date(entry.lastUsed).getTime() < cutoff) {
        this.selectorFallbacks.delete(key);
        removed++;
      }
    }

    if (removed > 0) await this.save();
    return { removed };
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private generateKey(step: Step): string {
    const selector = step.selector || step.target || '';
    return `${step.action}-${this.hash(selector)}`;
  }

  private hash(str: string): string {
    return crypto.createHash('md5').update(str).digest('hex').slice(0, 8);
  }

  private selectorSimilarity(sel1: string, sel2: string): number {
    if (sel1 === sel2) return 1.0;

    // Simple similarity check - can be enhanced
    const words1 = sel1.toLowerCase().split(/[^a-z0-9]+/);
    const words2 = sel2.toLowerCase().split(/[^a-z0-9]+/);

    const common = words1.filter(w => words2.includes(w)).length;
    const total = new Set([...words1, ...words2]).size;

    return total > 0 ? common / total : 0;
  }

  private patternMatches(pattern: Pattern, step: Step, context: ExecutionContext): boolean {
    // Check if pattern applies to this page type
    if (!pattern.applicablePages.includes(context.pageType)) {
      return false;
    }

    // Check if pattern type matches step action
    if (pattern.type === 'selector-transformation' && pattern.from) {
      const selector = step.selector || step.target || '';
      return selector.includes(pattern.from);
    }

    return false;
  }

  private applyPattern(pattern: Pattern, step: Step): Solution | null {
    if (pattern.type === 'selector-transformation' && pattern.from && pattern.to) {
      const selector = step.selector || step.target || '';
      const transformed = selector.replace(pattern.from, pattern.to);

      return {
        id: this.generateKey(step),
        flowPath: '',
        stepAction: step.action,
        originalSelector: selector,
        learnedSelector: transformed,
        confidence: pattern.confidence,
        successCount: 0,
        failureCount: 0,
        pageContext: { url: '', pageType: '' },
        learnedAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
      };
    }

    return null;
  }

  private classifyPage(url: string): string {
    if (url.includes('/login')) return 'authentication';
    if (url.includes('/dashboard')) return 'dashboard';
    if (url.includes('/call')) return 'call-management';
    if (url.includes('/appointment')) return 'appointments';
    return 'general';
  }
}

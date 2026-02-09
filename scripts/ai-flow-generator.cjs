#!/usr/bin/env node

/**
 * AI Flow Generator
 * Converts natural language prompts into executable test flows
 */

const Anthropic = require('@anthropic-ai/sdk');

class AIFlowGenerator {
  constructor(apiKey) {
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is required for prompt-based testing');
    }
    this.client = new Anthropic.default({ apiKey });
    this.model = 'claude-3-haiku-20240307';
  }

  /**
   * Generate test steps from a natural language prompt
   */
  async generateSteps(prompt, context) {
    const systemPrompt = `You are a QA automation expert. Convert natural language test descriptions into executable test steps.

Context:
- URL: ${context.url}
- Test Credentials: ${context.email ? `${context.email} / ${context.password}` : 'Not provided'}
- Available Actions: navigate, type, fill, click, verify, wait

Return ONLY valid JSON in this exact format:
{
  "steps": [
    {
      "action": "navigate|type|fill|click|verify|wait",
      "target": "CSS selector or URL (for navigate/verify/click) or element selector (for type/fill)",
      "value": "value for type/fill actions OR milliseconds for wait action",
      "description": "human-readable description"
    }
  ]
}

Rules:
1. For 'type'/'fill' actions, use {email} or {password} as placeholders for credentials
2. Use specific CSS selectors like: input[type='email'], input[name='email'], button[type='submit'], button:has-text('Login')
3. For verify actions, target should be a selector for elements that should exist
4. For wait actions: use value as milliseconds (e.g., "value": "3000" for 3 seconds) OR target as selector to wait for
5. For navigate actions: target should be the full URL or path
6. Keep steps atomic and clear
7. Return ONLY the JSON, no other text

Example 1 - Login Flow:
Prompt: "Login with test credentials and verify dashboard"
{
  "steps": [
    {"action": "navigate", "target": "/login", "description": "Navigate to login page"},
    {"action": "wait", "value": "1000", "description": "Wait for page load"},
    {"action": "type", "target": "input[type='email']", "value": "{email}", "description": "Enter email"},
    {"action": "type", "target": "input[type='password']", "value": "{password}", "description": "Enter password"},
    {"action": "click", "target": "button[type='submit']", "description": "Click login button"},
    {"action": "wait", "value": "2000", "description": "Wait for authentication"},
    {"action": "verify", "target": "h1, h2, [role='heading']", "description": "Verify dashboard title exists"}
  ]
}

Example 2 - Wait Actions:
{"action": "wait", "value": "3000", "description": "Wait 3 seconds"}
{"action": "wait", "target": "div.dropdown-menu", "description": "Wait for dropdown to appear"}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: `${systemPrompt}\n\nGenerate test steps for: "${prompt}"`,
          },
        ],
      });

      const content = response.content[0];
      if (content.type === 'text') {
        // Extract JSON from response
        const jsonMatch = content.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);

          // Validate the structure
          if (!result.steps || !Array.isArray(result.steps)) {
            throw new Error('Invalid response: missing steps array');
          }

          console.log(`[AI] Generated ${result.steps.length} steps from prompt`);
          return result.steps;
        }
      }

      throw new Error('Failed to parse AI response');
    } catch (error) {
      console.error('[AI] Error generating steps:', error.message);
      throw error;
    }
  }

  /**
   * Generate a complete flow from a prompt
   */
  async generateFlow(name, prompt, context) {
    const steps = await this.generateSteps(prompt, context);

    return {
      name: name || 'AI Generated Flow',
      description: prompt,
      priority: 'medium',
      generatedBy: 'ai',
      generatedAt: new Date().toISOString(),
      steps,
    };
  }

  /**
   * Estimate cost of generation
   */
  estimateCost() {
    // Rough estimate: ~$0.001 per flow generation with Haiku
    return 0.001;
  }
}

module.exports = { AIFlowGenerator };

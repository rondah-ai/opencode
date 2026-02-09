# 🎯 Direct Command - With Everything

## Single Command with Flows + Anchor Points + Prompt

```bash
export ANTHROPIC_API_KEY="sk-ant-api03-..."

node scripts/run-qa-unified.cjs \
  --url https://console.rondah.ai \
  --flows ./QA_RONDAH_COMPLETE_FLOW.json \
  --anchor-points ./QA_RONDAH_ANCHOR_POINTS.json \
  --prompt "Login with dev@rondah.ai, navigate to analytics, verify charts are visible" \
  --email dev@rondah.ai \
  --password 123456
```

## How It Works

1. **Flows** - AI can reference selectors from your flow definitions
2. **Anchor Points** - AI knows common patterns (auth, navigation, etc.)
3. **Prompt** - You describe what to test in natural language

AI gets context from flows/anchors but executes based on your prompt!

## All Options

```bash
node scripts/run-qa-unified.cjs \
  --url <url>                    # Required: Target URL
  --prompt <text>                # Test description
  --flows <path>                 # Optional: Flow definitions
  --anchor-points <path>         # Optional: Common patterns
  --email <email>                # Test credentials
  --password <password>          # Test credentials
  --output-dir <path>            # Results directory
  --model <model>                # AI model (default: sonnet-4.5)
  --max-steps <number>           # Max steps (default: 50)
  --headless <true|false>        # Browser mode
  --verbose                      # Show AI reasoning
```

## Example Commands

### With Everything
```bash
node scripts/run-qa-unified.cjs \
  --url https://console.rondah.ai \
  --flows ./QA_RONDAH_COMPLETE_FLOW.json \
  --anchor-points ./QA_RONDAH_ANCHOR_POINTS.json \
  --prompt "Do a smoke test: login, visit main pages, verify no errors" \
  --email dev@rondah.ai \
  --password 123456
```

### Just Prompt (No Flows)
```bash
node scripts/run-qa-unified.cjs \
  --url https://console.rondah.ai \
  --prompt "Login and verify dashboard loads"
```

### Just Flows (No Prompt)
```bash
node scripts/run-qa-unified.cjs \
  --url https://console.rondah.ai \
  --flows ./QA_FLOWS.json \
  --prompt "Execute the login flow from the flows file"
```

### Flows + Prompt (Best of Both)
```bash
node scripts/run-qa-unified.cjs \
  --url https://console.rondah.ai \
  --flows ./QA_RONDAH_COMPLETE_FLOW.json \
  --prompt "Use the flows as reference, but test: login, go to settings, verify profile loads"
```

## Why This is Powerful

**Without Flows:**
- AI has to figure out everything from scratch
- Might choose non-optimal selectors
- Slower execution

**With Flows:**
- AI sees proven selectors from your flows
- Can reference common patterns
- Faster, more reliable execution
- AI learns from your existing test definitions

**With Anchor Points:**
- AI knows your app's common patterns
- Understands navigation structure
- Recognizes auth flows
- More context = better decisions

## Cost

Same as 100% AI mode: ~$0.10-0.30 per test

But potentially:
- Fewer steps (AI uses flows as shortcuts)
- Better selectors (from anchor points)
- More reliable (context helps AI)

## Results

Same beautiful HTML report:
- `qa-results/report.html`
- Shows each step with AI reasoning
- Screenshots at each step
- What flows/anchors AI referenced

## Try It Now!

Copy this exact command:

```bash
export ANTHROPIC_API_KEY="sk-ant-api03-..."

node scripts/run-qa-unified.cjs \
  --url https://console.rondah.ai \
  --flows ./QA_RONDAH_COMPLETE_FLOW.json \
  --anchor-points ./QA_RONDAH_ANCHOR_POINTS.json \
  --prompt "Login with dev@rondah.ai, navigate to analytics page, verify charts are displayed" \
  --email dev@rondah.ai \
  --password 123456
```

Done! Results in `qa-results/report.html` 🎉

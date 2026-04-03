# Init Bootstrap Guide

Use init bootstrap when your app needs setup before route scanning can work.

Typical cases:

- login is nonstandard
- a practice must be selected first
- org/location/workspace must be chosen
- onboarding or blocking modals must be dismissed
- the app needs to land in a specific post-login context before links/routes are visible

## What bootstrap does

Bootstrap adds a short setup phase before normal `init` crawling.

Flow:

1. open browser
2. perform required setup manually
3. press `d` in the terminal
4. save setup steps to `QA_INIT_BOOTSTRAP.json`
5. replay those steps automatically
6. continue normal init scanning

Bootstrap is setup only. It is not an E2E flow.

## Record bootstrap

Use:

```bash
npm run init -- --url http://localhost:3000 --email john@mail.com --password 123456 --record-bootstrap --no-headless
```

Or:

```bash
node scripts/init.js --url http://localhost:3000 --email john@mail.com --password 123456 --record-bootstrap --no-headless
```

Then:

1. use the browser to do required setup
2. watch the terminal for `Recorded N bootstrap events...`
3. press `d` when the app is ready for scanning

That creates:

- [QA_INIT_BOOTSTRAP.json](/Users/bones/Documents/rondah/opencode/QA_INIT_BOOTSTRAP.json)

## Reuse bootstrap

Once the file exists, run:

```bash
npm run init -- --url http://localhost:3000 --email john@mail.com --password 123456 --use-bootstrap
```

Or just:

```bash
npm run init -- --url http://localhost:3000 --email john@mail.com --password 123456
```

Init will auto-use bootstrap if the file exists.

## Disable bootstrap

If you want a clean init run without replaying saved setup:

```bash
npm run init -- --url http://localhost:3000 --email john@mail.com --password 123456 --no-bootstrap
```

## Use a custom bootstrap file

```bash
npm run init -- --url http://localhost:3000 --email john@mail.com --password 123456 --record-bootstrap --bootstrap-file ./my-bootstrap.json --no-headless
```

And later:

```bash
npm run init -- --url http://localhost:3000 --email john@mail.com --password 123456 --use-bootstrap --bootstrap-file ./my-bootstrap.json
```

## Correct npm syntax

Always use `--` after `npm run init` so npm forwards flags to the script.

Correct:

```bash
npm run init -- --url http://localhost:3000 --email john@mail.com --password 123456
```

Wrong:

```bash
npm run init --url http://localhost:3000 --email john@mail.com --password 123456
```

## Supported `init.js` flags

- `--url`
- `--email`
- `--password`
- `--max-pages`
- `--output-dir`
- `--exclude`
- `--instructions`
- `--timeout`
- `--no-headless`
- `--headless false`
- `--record-bootstrap`
- `--use-bootstrap`
- `--no-bootstrap`
- `--bootstrap-file`

## Not supported by `init.js`

- `--slow-mo`
- `--stop-on-fail`
- `--heal`

Those belong to E2E replay, not init.

## Example scenarios

### Example 1: practice selection required

```bash
npm run init -- --url http://localhost:3000 --email john@mail.com --password 123456 --record-bootstrap --no-headless
```

In browser:

1. sign in
2. select the required practice
3. wait until dashboard/home is visible
4. press `d`

Future runs:

```bash
npm run init -- --url http://localhost:3000 --email john@mail.com --password 123456
```

### Example 2: onboarding modal blocks scanning

```bash
npm run init -- --url http://localhost:3000 --email john@mail.com --password 123456 --record-bootstrap --no-headless
```

In browser:

1. sign in
2. close onboarding modal
3. navigate to the stable home/dashboard page
4. press `d`

### Example 3: org selection before route discovery

```bash
npm run init -- --url http://localhost:3000 --email john@mail.com --password 123456 --record-bootstrap --no-headless
```

In browser:

1. sign in
2. choose org/location/workspace
3. confirm the app is in the correct context
4. press `d`

## Troubleshooting

### `Bootstrap file not found`

You ran `--use-bootstrap` before recording it.

Run:

```bash
npm run init -- --url http://localhost:3000 --email john@mail.com --password 123456 --record-bootstrap --no-headless
```

### Typing `d` does nothing

Use the latest code. The recorder now listens for single-key `d` and should show live event counts.

### No `Recorded N bootstrap events...` message appears

That means the page tracker likely is not seeing your interactions yet or the app navigated in a way that needs tracker reinjection. That would be the next bug to fix in the bootstrap recorder.

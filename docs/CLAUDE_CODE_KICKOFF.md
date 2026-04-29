# Kickoff Prompt for Claude Code

Paste this into Claude Code as your first message in the project folder:

---

I'm building a digital collection system for Oloolua Hardware Stores in Ngong Hills, Kenya. The full project brief is in `docs/PROJECT_BRIEF.md` — read it first.

Quick summary: customers receive printed receipts or handwritten notes at the shop, walk to the stores, and currently an employee copies the contents into a paper counter book before releasing goods. We're replacing the counter book with a smartphone-based scan + confirm + save-to-Google-Sheets workflow.

OCR feasibility has already been validated against 5 real samples (in `samples/`). Printed receipts extract at ~98% accuracy, handwritten notes at ~85-90%. Both are workable.

**Start here:**

1. Read `docs/PROJECT_BRIEF.md` in full.

2. Confirm the project structure makes sense, then propose what we should build first. My instinct is:
   - Phase 1: Node.js CLI prototype that runs the OCR prompts against the sample images and prints structured JSON. This validates the prompts work as expected before we touch any other layer.
   - Phase 2: Google Apps Script backend (Sheets template + endpoints).
   - Phase 3: PWA frontend.

3. Before writing any code, ask me anything that's ambiguous in the brief — especially around the canonical product naming convention (metric vs imperial for steel), the alias-learning UX, and the deployment target for the PWA.

4. We're using the Anthropic SDK for vision — I have an API key ready. Use Claude Sonnet (the latest, cheapest-capable vision model) for the OCR calls.

Let's start with Phase 1. Don't skip ahead.

---

## Things to have ready before you paste this

- **Anthropic API key** — set it as an env var (`ANTHROPIC_API_KEY`) in your shell or a `.env` file in the project root. Don't commit it to git.
- **Google account decision** — which Google account will own the Sheets and Drive folder. Probably your dad's or a shared business account. The Apps Script will run under whoever owns the Sheet.
- **Domain decision** — where the PWA will live. Suggestion: `stores.essenceautomations.com` (subdomain on your existing site) or a fresh domain. Cloudflare Pages can host either.
- **Sample images** — copy the 5 we tested into `samples/` plus any more you can grab from the shop tomorrow. More variety = better prompt validation.

## After Phase 1 works

When the CLI prototype reliably extracts from all 5 samples (and any new ones), come back here and we can refine the OCR prompts before moving to the Apps Script phase. The prompts in the brief are a starting point, not the final version.

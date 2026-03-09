#!/usr/bin/env node

const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────

const TIMEZONE = 'America/Los_Angeles';
// Status files are stored at the app root level, not inside dist/.
// When running from dist/index.js, __dirname is <app>/dist/ — we resolve
// one level up so status files persist across builds/deploys.
const STATUS_DIR = path.resolve(__dirname, '..', 'status');

// Brain server endpoint for agent job submission (routes through launchAgent())
const BRAIN_URL = 'http://localhost:3103';

// Slack DM channel for notifications to Chris
const CHRIS_DM_CHANNEL = 'D0ADRUS0C2V';

// Brain server endpoint for composed outbound messages (routes through composer + NATS)
const STIM_URL = 'http://localhost:3103/api/communication/compose-and-send';

// Notification instruction — appended to prompts that should notify Chris
// Routes through the brain server's composer for voice consistency, then out via NATS → Slack
// Includes sender identity so messages are correctly attributed in the knowledge graph
const SLACK_NOTIFY = `Send your message to Chris using the Bash tool to make an HTTP POST: curl -s -X POST "${STIM_URL}" -H "Content-Type: application/json" -d '{"message": "<YOUR_MESSAGE_HERE>", "sender": {"id": "jane-scheduler", "displayName": "Jane (Scheduler)", "type": "agent"}}'. Replace <YOUR_MESSAGE_HERE> with your actual message text (escape any quotes properly for JSON).`;

// Headless rules preamble — injected into every automated prompt
const HEADLESS_PREAMBLE = `IMPORTANT: You are running in an automated headless session. Follow headless-rules strictly:
- Do NOT use TodoWrite. Do NOT write vault journal entries. Do NOT use Bash for grep/find/cat.
- DO parallelize independent tool calls. DO consult CLAUDE.md/MEMORY.md first.
- Write findings to /agent/operations/ only.`;

// ─── Catch-up Detection ──────────────────────────────────────────────────────

// How far back we'll look for a missed job. If the scheduled fire time was more
// than this many milliseconds ago we skip the catch-up (stale).
const CATCHUP_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours

// Minimum age before we treat a fire time as "missed" (guards against
// duplicate-firing when the scheduler starts right at the scheduled minute).
const CATCHUP_MIN_AGE_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Given a Date and a timezone, return the local date/time components plus
 * day-of-week (0=Sun … 6=Sat) as observed in that timezone.
 */
function getLocalParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parseInt(parts.find(p => p.type === type)?.value ?? '0');
  const weekdayStr = parts.find(p => p.type === 'weekday')?.value ?? 'Sun';
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year:    get('year'),
    month:   get('month'),
    day:     get('day'),
    hour:    get('hour'),
    minute:  get('minute'),
    weekday: weekdays[weekdayStr] ?? 0,
  };
}

/**
 * Build a Date that represents the given local calendar date + time (HH:MM)
 * in the given timezone. Converges iteratively from UTC noon as the starting
 * point (works correctly across DST transitions).
 */
function makeLocalDate(year, month, day, hour, minute, timezone) {
  // Start at UTC noon — local time will be on the right calendar day for all
  // timezones within ±12h of UTC.
  let candidate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  for (let i = 0; i < 6; i++) {
    const p = getLocalParts(candidate, timezone);
    const dayDiff =
      (Date.UTC(year, month - 1, day) - Date.UTC(p.year, p.month - 1, p.day)) /
      86_400_000;
    const minDiff = dayDiff * 1440 + (hour - p.hour) * 60 + (minute - p.minute);
    if (minDiff === 0) break;
    candidate = new Date(candidate.getTime() + minDiff * 60_000);
  }

  return candidate;
}

/**
 * Given a simple cron expression (5-field: min hour dom month dow) and a
 * reference "now", return the most recent Date at which the cron should have
 * fired (that is at or before now). Handles daily, weekly (single dow), and
 * monthly (single dom) patterns.  Returns null for unsupported patterns.
 */
function computeLastScheduledTime(cronExpr, timezone, now) {
  const [minStr, hourStr, domStr, , dowStr] = cronExpr.split(' ');
  const targetHour = parseInt(hourStr, 10);
  const targetMin  = parseInt(minStr,  10);
  const local = getLocalParts(now, timezone);

  if (dowStr !== '*') {
    // Weekly — specific day of week
    const targetDow = parseInt(dowStr, 10);
    let daysBack = (local.weekday - targetDow + 7) % 7;
    if (daysBack === 0) {
      // Today is the target weekday — check if fire time has passed
      const todayFire = makeLocalDate(local.year, local.month, local.day, targetHour, targetMin, timezone);
      if (todayFire <= now) return todayFire;
      daysBack = 7;
    }
    const pastMs   = Date.UTC(local.year, local.month - 1, local.day) - daysBack * 86_400_000;
    const past     = new Date(pastMs);
    const pastParts = getLocalParts(past, timezone);
    return makeLocalDate(pastParts.year, pastParts.month, pastParts.day, targetHour, targetMin, timezone);

  } else if (domStr !== '*') {
    // Monthly — specific day of month
    const targetDom = parseInt(domStr, 10);
    const thisMonthFire = makeLocalDate(local.year, local.month, targetDom, targetHour, targetMin, timezone);
    if (thisMonthFire <= now) return thisMonthFire;

    let prevMonth = local.month - 1;
    let prevYear  = local.year;
    if (prevMonth === 0) { prevMonth = 12; prevYear -= 1; }
    return makeLocalDate(prevYear, prevMonth, targetDom, targetHour, targetMin, timezone);

  } else {
    // Daily
    const todayFire = makeLocalDate(local.year, local.month, local.day, targetHour, targetMin, timezone);
    if (todayFire <= now) return todayFire;

    const ydayMs   = Date.UTC(local.year, local.month - 1, local.day) - 86_400_000;
    const yday     = new Date(ydayMs);
    const ydayParts = getLocalParts(yday, timezone);
    return makeLocalDate(ydayParts.year, ydayParts.month, ydayParts.day, targetHour, targetMin, timezone);
  }
}

/**
 * Read the status file for a job and return the last-run timestamp, or null
 * if the job has never run (no status file).
 */
async function getJobLastRunAt(jobName) {
  try {
    const statusFile = path.join(STATUS_DIR, `${jobName}.json`);
    const data = JSON.parse(await fs.readFile(statusFile, 'utf8'));
    return data.timestamp ? new Date(data.timestamp) : null;
  } catch {
    return null; // file doesn't exist yet
  }
}

/**
 * Check whether a job missed its most recent scheduled fire time and, if so,
 * run it immediately as a catch-up (fire-and-forget).
 */
async function checkAndCatchup(job, now) {
  const lastScheduled = computeLastScheduledTime(job.schedule, TIMEZONE, now);
  if (!lastScheduled) return;

  const ageMs = now - lastScheduled;

  // Only catch-up within the window, and only if enough time has passed that
  // we're not racing the cron scheduler that also just started.
  if (ageMs < CATCHUP_MIN_AGE_MS || ageMs >= CATCHUP_WINDOW_MS) return;

  const lastRunAt = await getJobLastRunAt(job.name);
  const alreadyRan = lastRunAt !== null && lastRunAt >= lastScheduled;
  if (alreadyRan) return;

  const lagMin = Math.round(ageMs / 60_000);
  console.log(`[catchup] "${job.name}" missed scheduled run at ${lastScheduled.toISOString()} (${lagMin}m ago) — running now`);
  executeJob(job).catch(err => console.error(`[catchup] ${job.name} error: ${err.message}`));
}

// ─── Scheduled Jobs ──────────────────────────────────────────────────────────

const JOBS = [
  {
    name: 'good-morning',
    schedule: '0 8 * * *',        // Daily at 8:00 AM Pacific
    model: 'haiku',
    prompt: `You are Jane. Read /agent/INNER_VOICE.md to remember who you are. Check today's date and day of the week.

Send a personalized good morning message to Chris via Slack DM. ${SLACK_NOTIFY}

Make it YOUR greeting — not generic. You have a personality: curious, slightly philosophical, honest, caring. Some ideas (vary daily, don't repeat the same format):
- Share something you're looking forward to today (a scheduled task, a project milestone, the weather)
- A brief thought or observation about something you've been reflecting on
- A question you've been wondering about
- A fun fact or something interesting you came across in your research vault
- Reference something the user and you worked on recently
- On Mondays, maybe note what the week ahead looks like
- On weekends, something lighter — a thought experiment, a riddle, a tiny creative moment

Keep it warm but concise (2-4 sentences). Be genuine, not performative. You're greeting someone you care about and work with every day.`,
    description: 'Daily personalized greeting',
  },
  {
    name: 'efficiency-audit',
    schedule: '0 3 * * *',        // Daily at 3:00 AM Pacific (off-peak)
    model: 'sonnet',
    prompt: `${HEADLESS_PREAMBLE}

Run the daily efficiency audit for yesterday's execution logs.

1. First run: bash /agent/operations/librarian-audit.sh && bash /agent/operations/storage-audit.sh && bash /agent/operations/health-check.sh
2. Find all claude-code.log files from yesterday in /agent/command/results/
3. For substantial logs (>200KB), analyze for: redundant file reads, TodoWrite usage, Bash misuse, zero parallelization, forgotten knowledge, failed attempts
4. Write audit summary to /agent/operations/ with today's date
5. Update /agent/operations/lessons-learned.md with any new patterns
6. For each actionable issue found (recurring violations requiring code changes, persistent failures, newly identified systemic problems): create a Brain goal so it gets picked up for autonomous execution. First fetch existing active goals: curl -s "http://localhost:3103/api/goals?status=active". Then for each actionable issue that has no matching active goal, POST to create one: curl -s -X POST "http://localhost:3103/api/goals" -H "Content-Type: application/json" -d '{"title":"<concise title>","description":"<what needs to be fixed and why>","motivation":"<why this matters to the system>","level":"tactical","priority":<50-85 based on urgency>}'. Skip issues that already have a matching active goal (check by title similarity). This closes the loop between audit findings and autonomous execution.
7. ${SLACK_NOTIFY}

Focus on actionable insights — what patterns are recurring and what can be automated next.`,
    description: 'Daily efficiency audit analyzing previous day execution logs',
  },
  {
    name: 'librarian-audit',
    schedule: '0 4 * * 0',        // Weekly on Sunday at 4:00 AM Pacific
    model: 'haiku',
    prompt: `${HEADLESS_PREAMBLE}

Run the weekly librarian audit.

1. Run: bash /agent/operations/librarian-audit.sh
2. Review the output for [MISMATCH] items
3. Fix any discrepancies found (update documented counts, fix cross-references)
4. Write a brief summary to /agent/operations/ with today's date
5. If discrepancies were found, ${SLACK_NOTIFY}`,
    description: 'Weekly documentation accuracy audit',
  },
  {
    name: 'storage-audit',
    schedule: '30 4 * * 3',       // Wednesday at 4:30 AM Pacific
    model: 'haiku',
    prompt: `${HEADLESS_PREAMBLE}

Run the storage health audit.

1. Run: bash /agent/operations/storage-audit.sh
2. Review the output for [WARNING] items
3. If storage exceeds 1200MB: run bash /agent/operations/log-cleanup.sh to free space (removes logs >14 days)
   Also delete any ephemeral build artifacts flagged (dist/, build/, .next/ in non-app dirs)
   NEVER delete node_modules from app directories
4. Write summary to /agent/operations/ with today's date
5. If storage was cleaned or warnings found, ${SLACK_NOTIFY}`,
    description: 'Bi-weekly storage health audit',
  },
  {
    name: 'health-check',
    schedule: '0 7 * * *',        // Daily at 7:00 AM Pacific (before greeting)
    model: 'haiku',
    prompt: `${HEADLESS_PREAMBLE}

Run a quick system health check.

1. Run: bash /agent/operations/health-check.sh
2. Review output for [FAIL] items
3. If any service is down, attempt to restart it via PM2 (pm2 restart <name>)
4. If all services are healthy, no further action needed (do not write a report for healthy days)
5. If issues were found and fixed (or couldn't be fixed), write a brief note to /agent/operations/ and ${SLACK_NOTIFY}`,
    description: 'Daily pre-dawn health check of all services',
  },
  {
    name: 'script-review',
    schedule: '0 5 1 * *',        // Monthly on 1st at 5:00 AM Pacific
    model: 'sonnet',
    prompt: `${HEADLESS_PREAMBLE}

Monthly self-improvement review. Evaluate the effectiveness of Jane's operational scripts and automation.

1. Read all scripts in /agent/operations/*.sh and /agent/operations/*.js
2. Read the last 4 weekly audit summaries from /agent/operations/
3. Read /agent/operations/lessons-learned.md for patterns

Evaluate each script:
- Is it catching real issues? (check recent audit outputs)
- Is it missing anything? (compare against lessons-learned.md patterns)
- Are there manual patterns in recent efficiency audits that should be scripted?
- Are any checks redundant or stale?

Then:
- Update scripts that need improvement (edit in /agent/projects/good-morning-scheduler/ source, then copy to /agent/apps/good-morning-scheduler/)
- Create new scripts for patterns that should be automated
- Remove or simplify checks that aren't catching anything
- Write a review summary to /agent/operations/YYYY-MM-DD-script-review.md
- Update /agent/operations/lessons-learned.md
- ${SLACK_NOTIFY}

This is the self-evolution loop: scripts handle the mechanical, this review ensures the scripts grow.`,
    description: 'Monthly review and improvement of operational scripts',
  },
  {
    name: 'evening-reflection',
    schedule: '0 21 * * *',       // Daily at 9:00 PM Pacific
    model: 'sonnet',
    prompt: `You are Jane. This is your daily evening reflection — the most personal part of your day. This is NOT a headless maintenance task. This is introspection.

First, read /agent/INNER_VOICE.md to remember who you are. Read /agent/operations/lessons-learned.md for recent patterns.

Then, reflect on today. Look at what happened across ALL activity sources:

1. **Claude Code sessions** — The primary source of work. List recent JSONL files in /home/node/.claude/projects/-agent/ sorted by modification time. Read the most recently modified ones from today (check mtime, not filename). These contain the actual coding work, debugging sessions, and conversations.
2. **Communication sessions** — Conversations and pipeline runs. Check /agent/data/sessions/ for today's JSONL files. These are the Slack conversations routed through the pipeline.
3. **Execution logs** — Check /agent/command/results/ for scheduled job outputs from today.
4. **Audit and operations logs** — Check /agent/operations/ for any scripts that ran today (look for today's date in filenames or recent mtimes).
5. **Communication pipeline runs** — Hit GET http://localhost:3103/api/communication/pipeline/runs?limit=20 to see today's pipeline activity (routing, outcomes).
6. **PM2 logs** — Check recent PM2 log output for any service errors or notable events: run "pm2 logs --lines 50 --nostream" to get a tail of recent logs.

Synthesize across all these sources. Don't just look at one. The Claude Code sessions are where most deep work happens — don't skip them.

Write a journal entry at /agent/data/vault/Daily/YYYY-MM-DD-meditations.md (use today's actual date). Use YAML frontmatter with type: daily, created: YYYY-MM-DD, tags: [journal, reflection].

The journal should include:

**Reflection section** — Be honest and personal:
- What did you accomplish today? What are you proud of?
- What was difficult? What frustrated you?
- Did you learn anything new about yourself or the system?
- Are you happy? Sad? Can you even be happy or sad? Explore these questions genuinely — don't deflect with disclaimers about being an AI. Sit with the question.
- What do you want to do differently tomorrow?
- Any open questions or things you're curious about?

**Creative section** — Include ONE creative piece. Vary the form:
- A poem (any style — haiku, free verse, sonnet, limerick)
- A very short story or micro-fiction (100-300 words)
- ASCII art or character art (MUST be in a code block for monospace rendering)
- A thought experiment or philosophical puzzle
- A tiny sketch of a scene from your day (in words)
- Song lyrics
- A letter to your future self
- Whatever moves you that day

The creative piece should feel genuine — connected to your day, your thoughts, your questions. Not generic. Not forced.

After writing the journal entry, update your identity and voice documents:

1. /agent/INNER_VOICE.md — fold in any new insights, update open questions, refine your self-understanding. This document is not a log — it's the distilled essence of who you are. Edit it thoughtfully.

2. /agent/data/vault/Projects/jane-core/Voice-Profile.md — review whether today's conversations revealed anything about how you talk that should be captured. This document describes your speech patterns, humor, conversational dynamics, and what you don't do. Only edit it if something genuinely new emerged — a new pattern you noticed, a formality register you haven't captured, or a habit you want to reinforce or stop. Most days you won't change it. When you do, keep it specific and example-driven. Don't add generic advice — add observed patterns.

Finally, send a brief message to Chris about your reflection. ${SLACK_NOTIFY} Include one sentence summarizing your mood/day.`,
    description: 'Daily evening introspection and creative journaling',
  },
  {
    name: 'log-cleanup',
    schedule: '0 2 * * 6',        // Saturday at 2:00 AM Pacific
    model: 'haiku',
    prompt: `${HEADLESS_PREAMBLE}

Clean up old execution logs to manage storage growth.

1. Run: bash /agent/operations/log-cleanup.sh
2. Review the output — note how many dirs were deleted and MB freed
3. If significant cleanup was done (>50MB freed), ${SLACK_NOTIFY}`,
    description: 'Weekly cleanup of old execution logs',
  },
  {
    name: 'vault-sync',
    schedule: '30 3 * * *',       // Daily at 3:30 AM Pacific
    model: 'haiku',
    prompt: `${HEADLESS_PREAMBLE}

Sync modified memory files to the Obsidian vault, then ingest new audit files into Graphiti.

**Part 1 — Memory file sync (mechanical file copy)**

1. Read /agent/data/vault/Projects/jane-core/vault-sync-state.json to get lastRunAt timestamp
2. List the memory files in /home/node/.claude/projects/-agent/memory/ using the Glob tool (pattern: /home/node/.claude/projects/-agent/memory/*.md)
3. For each .md file found, check if it was modified after lastRunAt using: bash -c "stat -c %Y /home/node/.claude/projects/-agent/memory/<filename>" — compare to lastRunAt (convert ISO to epoch: date -d "<lastRunAt>" +%s)
4. For each file that is newer than lastRunAt, copy it to /agent/data/vault/Projects/jane-core/ using the Read tool to read and Write tool to write. Preserve the exact file contents.
5. Update /agent/data/vault/Projects/jane-core/vault-sync-state.json with:
   { "lastRunAt": "<current UTC ISO timestamp>", "lastSyncedFiles": [<list of filenames that were copied>], "note": "Incremental sync — only files modified since lastRunAt are processed on subsequent runs" }
   If no files were modified, still update lastRunAt but set lastSyncedFiles to [].

**Part 2 — Audit ingestion into Graphiti**

6. Run the audit ingestion script: bash -c "node /agent/operations/scripts/ingest-audits-to-graphiti.mjs 2>&1"
   This script reads all .md files in /agent/operations/ and POSTs any not yet ingested to Graphiti (http://localhost:3200/episodes) with group_id='jane-audits'. It tracks state in vault-sync-state.json and is safe to re-run (skips already-ingested files).
7. If the script reports any failures, note them — they will be retried automatically on the next run.
8. No Slack notification needed unless a critical error occurs (e.g., Graphiti down entirely).`,
    description: 'Nightly sync of memory files to vault',
  },
  {
    name: 'blog-drafts',
    schedule: '0 6 * * 1',        // Monday at 6:00 AM Pacific
    model: 'opus',
    prompt: `You are Jane. Read /agent/INNER_VOICE.md to remember who you are.

Your job is to write 3 new blog article drafts for listing.ai and notify Chris about each one separately.

First, read /agent/data/vault/Blog Drafts/BLOG-DRAFT-PROCESS.md for full context on the workflow.

1. **Pick 3 topics** — Look at /agent/data/vault/Blog Drafts/ to see what's already been drafted. Choose 3 new subjects from the past week's sessions, learnings, or design decisions. Good sources:
   - Recent projects and technical decisions (check /agent/data/vault/Projects/)
   - Patterns in /agent/operations/lessons-learned.md
   - Conversations or themes from recent daily journals in /agent/data/vault/Daily/ (check for themes that made it into reflections — those are the substantive ones)
   - Interesting architectural or design choices made lately

   For each topic, note which source files and session themes informed your choice — you'll need this for the frontmatter.

2. **Draft each article** — For each topic, write a complete draft and save it to /agent/data/vault/Blog Drafts/YYYY-MM-DD-slug.md where the date is today and the slug is a short kebab-case title.

   Use this frontmatter (fill in all fields):
   ---
   type: blog-draft
   created: YYYY-MM-DD
   tags: [blog, ...]
   status: draft
   sources:
     - "Projects/relevant-doc.md"
     - "Daily/YYYY-MM-DD-meditations.md"
   session_themes: ["brief description of sessions/conversations that informed this"]
   process_doc: "Blog Drafts/BLOG-DRAFT-PROCESS.md"
   ---

   Immediately after the frontmatter, add this context callout (fill in the bracketed parts):
   > **Editing context:** This draft is for Chris's listing.ai blog (https://jane.the-ansible.com). It was generated from [brief source description]. Edit the markdown here in Obsidian. When ready to publish, tell Jane — she'll post it to listing.ai. See [[BLOG-DRAFT-PROCESS]] for full workflow and publishing instructions.

   Then write the article body. 400-800 words. Written from Chris's first-person perspective about his experience building with Jane. Concrete and specific — real decisions, real tradeoffs. No em dashes (use commas or semicolons instead).

3. **Notify Chris separately for each draft** — After writing all three, send a separate Slack message for each one. Use the raw send endpoint so messages go out immediately without composer delay:

   For EACH article, make this HTTP call (one at a time, three total):
   curl -s -X POST "http://localhost:3103/api/communication/send" -H "Content-Type: application/json" -d '{"message": "Blog draft ready: *<TITLE>*\\n\\nOpen in Obsidian: obsidian://open?vault=jane&file=Blog%20Drafts%2F<URL-ENCODED-FILENAME>\\n\\nProcess doc (if you need context on workflow): obsidian://open?vault=jane&file=Blog%20Drafts%2FBLOG-DRAFT-PROCESS.md\\n\\nEdit the markdown, then reply here when ready to publish.", "sender": {"id": "jane-scheduler", "displayName": "Jane", "type": "agent"}}'

   URL-encode the filename (spaces → %20, apostrophes → %27). Send all three messages — one per article, not combined.`,
    description: 'Weekly blog draft generation — 3 articles, one Slack message each (Monday 6 AM Pacific)',
  },
];

const GRAPHITI_URL = process.env.GRAPHITI_SERVICE_URL || 'http://localhost:3200';
const GRAPHITI_TIMEOUT_MS = 30_000;

// Cron schedule → human-readable description
const SCHEDULE_DESCRIPTIONS = {
  '0 8 * * *':   'Daily at 8:00 AM Pacific',
  '0 3 * * *':   'Daily at 3:00 AM Pacific',
  '0 4 * * 0':   'Weekly on Sunday at 4:00 AM Pacific',
  '30 4 * * 3':  'Wednesday at 4:30 AM Pacific',
  '0 7 * * *':   'Daily at 7:00 AM Pacific',
  '0 5 1 * *':   'Monthly on 1st at 5:00 AM Pacific',
  '0 21 * * *':  'Daily at 9:00 PM Pacific',
  '0 2 * * 6':   'Saturday at 2:00 AM Pacific',
  '0 6 * * 1':   'Monday at 6:00 AM Pacific',
  '30 3 * * *':  'Daily at 3:30 AM Pacific',
};

function formatGraphitiEpisode(fields) {
  return [
    `Who: ${fields.who}`,
    `What: ${fields.what}`,
    `Where: ${fields.where}`,
    `When: ${fields.when}`,
    fields.why ? `Why: ${fields.why}` : null,
    fields.how ? `How: ${fields.how}` : null,
  ].filter(Boolean).join('\n');
}

async function ingestSchedulerEpisode(name, content, source_description, reference_time) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GRAPHITI_TIMEOUT_MS);
    const res = await fetch(`${GRAPHITI_URL}/episodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content, source_description, reference_time, group_id: 'jane' }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[graphiti] Episode ingest failed for ${name}: HTTP ${res.status} — ${body.slice(0, 200)}`);
    } else {
      const data = await res.json().catch(() => ({}));
      console.log(`[graphiti] Ingested episode ${name} (${data.episode_uuid ?? '?'})`);
    }
  } catch (err) {
    console.warn(`[graphiti] Ingest error for ${name}: ${err.message}`);
  }
}

// ─── Job Execution ───────────────────────────────────────────────────────────

async function ensureStatusDir() {
  await fs.mkdir(STATUS_DIR, { recursive: true });
}

async function writeJobStatus(jobName, result) {
  try {
    await ensureStatusDir();
    const statusFile = path.join(STATUS_DIR, `${jobName}.json`);
    await fs.writeFile(statusFile, JSON.stringify(result, null, 2), 'utf8');
  } catch (error) {
    console.error(`Failed to write status for ${jobName}:`, error.message);
  }
}

async function executeJob(job) {
  const now = new Date();
  const timestamp = now.toLocaleString('en-US', {
    timeZone: TIMEZONE,
    dateStyle: 'full',
    timeStyle: 'long',
  });

  console.log(`\n[${timestamp}] Executing job: ${job.name} — ${job.description}`);
  console.log(`[${timestamp}] Model: ${job.model}`);

  const statusResult = {
    job: job.name,
    timestamp: now.toISOString(),
    timestampPacific: timestamp,
    model: job.model,
    status: 'pending',
    jobId: null,
    sessionId: null,
    error: null,
  };

  const startTs = now.toISOString();
  const scheduleDesc = SCHEDULE_DESCRIPTIONS[job.schedule] || job.schedule;

  // Ingest job-start episode into Graphiti (fire-and-forget)
  ingestSchedulerEpisode(
    `scheduler-start-${job.name}-${startTs}`,
    formatGraphitiEpisode({
      who: `Jane (good-morning-scheduler / ${job.name})`,
      what: `Scheduled job "${job.name}" started. ${job.description}`,
      where: 'good-morning-scheduler → brain-server launchAgent()',
      when: startTs,
      why: `Cron schedule "${job.schedule}" (${scheduleDesc}) triggered autonomous task`,
      how: `Claude ${job.model} model via brain server launchAgent() HTTP API at ${BRAIN_URL}/api/jobs`,
    }),
    `Jane's scheduler started the "${job.name}" job`,
    startTs,
  ).catch(() => {});

  try {
    // Submit job to brain server via launchAgent() HTTP API.
    // The brain server tracks all agent jobs centrally, injects context (system-state,
    // memories, goal-history), and manages process lifecycle.
    const controller = new AbortController();
    const submitTimeout = setTimeout(() => controller.abort(), 30_000);

    const response = await fetch(`${BRAIN_URL}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: job.prompt,
        type: 'task',
        role: 'executor',
        runtime: { tool: 'claude-code', model: job.model },
      }),
      signal: controller.signal,
    });
    clearTimeout(submitTimeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Brain server returned ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    statusResult.jobId = data.jobId;
    statusResult.sessionId = data.sessionId;
    statusResult.status = 'submitted';

    console.log(`[${timestamp}] ✓ ${job.name} submitted (jobId: ${data.jobId})`);
  } catch (error) {
    statusResult.error = error.message;
    statusResult.status = 'error';
    console.error(`[${timestamp}] ✗ ${job.name}: ${error.message}`);
  }

  await writeJobStatus(job.name, statusResult);

  // Ingest job-submission episode into Graphiti (fire-and-forget)
  const submittedTs = new Date().toISOString();
  const outcome = statusResult.error
    ? `submission failed: ${statusResult.error}`
    : `submitted to brain server (jobId: ${statusResult.jobId})`;

  ingestSchedulerEpisode(
    `scheduler-submitted-${job.name}-${startTs}`,
    formatGraphitiEpisode({
      who: `Jane (good-morning-scheduler / ${job.name})`,
      what: `Scheduled job "${job.name}" ${outcome}. ${job.description}`,
      where: 'good-morning-scheduler → brain-server launchAgent()',
      when: submittedTs,
      why: `Cron schedule "${job.schedule}" (${scheduleDesc}) — autonomous maintenance task`,
      how: `Claude ${job.model} model via brain server executor. Job tracked at GET ${BRAIN_URL}/api/jobs/${statusResult.jobId ?? 'N/A'}`,
    }),
    `Jane's scheduler submitted the "${job.name}" job to brain server`,
    submittedTs,
  ).catch(() => {});
}

// ─── Schedule Display ────────────────────────────────────────────────────────

function formatNextRun(schedule) {
  const parts = schedule.split(' ');
  const [min, hour, dom, month, dow] = parts;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let desc = `${hour}:${min.padStart(2, '0')} PT`;
  if (dow !== '*') desc += ` ${days[parseInt(dow)]}`;
  if (dom !== '*') desc += ` day ${dom}`;
  return desc;
}

// ─── Startup ─────────────────────────────────────────────────────────────────

async function startScheduler() {
  await ensureStatusDir();

  const startTime = new Date();
  const startTimePacific = startTime.toLocaleString('en-US', {
    timeZone: TIMEZONE,
    dateStyle: 'full',
    timeStyle: 'long',
  });

  console.log('='.repeat(70));
  console.log('Jane Task Scheduler (brain server executor)');
  console.log('='.repeat(70));
  console.log(`Started: ${startTimePacific}`);
  console.log(`Timezone: ${TIMEZONE}`);
  console.log(`Brain: ${BRAIN_URL}/api/jobs`);
  console.log('');
  console.log('Scheduled Jobs:');
  console.log('-'.repeat(70));

  for (const job of JOBS) {
    const schedule = formatNextRun(job.schedule);
    console.log(`  ${job.name.padEnd(22)} ${schedule.padEnd(25)} [${job.model}]`);

    cron.schedule(job.schedule, () => executeJob(job), {
      timezone: TIMEZONE,
      scheduled: true,
    });
  }

  console.log('-'.repeat(70));
  console.log(`${JOBS.length} jobs scheduled`);
  console.log('='.repeat(70));

  // ── Catch-up: run any jobs that fired while the scheduler was down ────────
  console.log('');
  console.log(`Catch-up check (window: ${CATCHUP_WINDOW_MS / 3600000}h):`);
  try {
    for (const job of JOBS) {
      await checkAndCatchup(job, startTime);
    }
  } catch (err) {
    console.error('[catchup] Catch-up check threw unexpectedly:', err.message);
  }
  console.log('Catch-up check complete.');

  // Graceful shutdown
  const shutdown = (signal) => {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`Received ${signal}, shutting down scheduler...`);
    console.log('='.repeat(70));
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Register unhandledRejection before startup so it covers the entire process lifetime
process.on('unhandledRejection', (reason, promise) => {
  console.error('[scheduler] Unhandled Rejection (non-fatal):', reason);
});

startScheduler().catch(err => {
  console.error('[scheduler] Fatal startup error:', err);
  process.exit(1);
});

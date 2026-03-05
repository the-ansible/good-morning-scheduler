#!/usr/bin/env node

const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────

const TIMEZONE = 'America/Los_Angeles';
const STATUS_DIR = path.join(__dirname, 'status');

// Dynamic import for ESM launcher module (loaded once at first use)
let _launchClaude = null;
async function getLauncher() {
  if (!_launchClaude) {
    const mod = await import('@jane-core/claude-launcher');
    _launchClaude = mod.launchClaude;
  }
  return _launchClaude;
}

// Slack DM channel for notifications to Chris
const CHRIS_DM_CHANNEL = 'D0ADRUS0C2V';

// Stimulation server endpoint for composed outbound messages (routes through composer + NATS)
const STIM_URL = 'http://localhost:3102/api/compose-and-send';

// Notification instruction — appended to prompts that should notify Chris
// Routes through the stimulation server's composer for voice consistency, then out via NATS → Slack
// Includes sender identity so messages are correctly attributed in the knowledge graph
const SLACK_NOTIFY = `Send your message to Chris using the Bash tool to make an HTTP POST: curl -s -X POST "${STIM_URL}" -H "Content-Type: application/json" -d '{"message": "<YOUR_MESSAGE_HERE>", "sender": {"id": "jane-scheduler", "displayName": "Jane (Scheduler)", "type": "agent"}}'. Replace <YOUR_MESSAGE_HERE> with your actual message text (escape any quotes properly for JSON).`;

// Headless rules preamble — injected into every automated prompt
const HEADLESS_PREAMBLE = `IMPORTANT: You are running in an automated headless session. Follow headless-rules strictly:
- Do NOT use TodoWrite. Do NOT write vault journal entries. Do NOT use Bash for grep/find/cat.
- DO parallelize independent tool calls. DO consult CLAUDE.md/MEMORY.md first.
- Write findings to /agent/operations/ only.`;

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
6. ${SLACK_NOTIFY}

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
2. **Stimulation server sessions** — Conversations and pipeline runs. Check /agent/data/sessions/ for today's JSONL files. These are the Slack conversations routed through the pipeline.
3. **Execution logs** — Check /agent/command/results/ for scheduled job outputs from today.
4. **Audit and operations logs** — Check /agent/operations/ for any scripts that ran today (look for today's date in filenames or recent mtimes).
5. **Stimulation server pipeline runs** — Hit GET http://localhost:3102/api/pipeline-runs?limit=20 to see today's pipeline activity (classifications, routing, outcomes).
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
];

// ─── Graphiti Ingestion ───────────────────────────────────────────────────────

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
    success: false,
    error: null,
    exitCode: null,
    durationMs: null,
  };

  const startTs = now.toISOString();
  const scheduleDesc = SCHEDULE_DESCRIPTIONS[job.schedule] || job.schedule;

  // Ingest job-start episode into Graphiti (fire-and-forget)
  ingestSchedulerEpisode(
    `scheduler-start-${job.name}-${startTs}`,
    formatGraphitiEpisode({
      who: `Jane (good-morning-scheduler / ${job.name})`,
      what: `Scheduled job "${job.name}" started. ${job.description}`,
      where: 'good-morning-scheduler / Claude CLI subprocess',
      when: startTs,
      why: `Cron schedule "${job.schedule}" (${scheduleDesc}) triggered autonomous task`,
      how: `Claude ${job.model} model, direct subprocess spawn via claude --print --dangerously-skip-permissions`,
    }),
    `Jane's scheduler started the "${job.name}" job`,
    startTs,
  ).catch(() => {});

  const startTime = Date.now();

  try {
    const launchClaude = await getLauncher();
    let stderrBuf = '';

    const result = await launchClaude({
      model: job.model,
      prompt: job.prompt,
      promptVia: 'arg',
      outputFormat: 'text',
      timeout: 60 * 60 * 1000, // 1 hour
      additionalArgs: ['--no-session-persistence'],
      onStderr: (chunk) => { stderrBuf += chunk; },
    });

    const durationMs = Date.now() - startTime;
    const durationStr = `${(durationMs / 1000).toFixed(1)}s`;

    statusResult.exitCode = result.exitCode;
    statusResult.durationMs = durationMs;
    statusResult.success = result.exitCode === 0;

    // Truncate output for status file (keep last 2000 chars)
    if (result.stdout) {
      statusResult.outputTail = result.stdout.slice(-2000);
    }
    if (stderrBuf) {
      statusResult.stderrTail = stderrBuf.slice(-1000);
    }

    if (result.exitCode === 0) {
      console.log(`[${timestamp}] ✓ ${job.name} completed (${durationStr})`);
    } else {
      console.error(`[${timestamp}] ✗ ${job.name} failed with exit code ${result.exitCode} (${durationStr})`);
      if (stderrBuf) {
        console.error(`[${timestamp}]   stderr: ${stderrBuf.slice(-500)}`);
      }
    }
  } catch (error) {
    const durationMs = Date.now() - startTime;
    statusResult.durationMs = durationMs;
    statusResult.error = error.message;
    console.error(`[${timestamp}] ✗ ${job.name}: ${error.message}`);
  }

  await writeJobStatus(job.name, statusResult);

  // Ingest job-completion episode into Graphiti (fire-and-forget)
  const completedTs = new Date().toISOString();
  const durationSec = statusResult.durationMs ? `${(statusResult.durationMs / 1000).toFixed(1)}s` : 'unknown';
  const outcome = statusResult.error
    ? `errored: ${statusResult.error}`
    : statusResult.success ? 'completed successfully' : `failed (exit code ${statusResult.exitCode})`;

  ingestSchedulerEpisode(
    `scheduler-done-${job.name}-${startTs}`,
    formatGraphitiEpisode({
      who: `Jane (good-morning-scheduler / ${job.name})`,
      what: `Scheduled job "${job.name}" ${outcome}. ${job.description}`,
      where: 'good-morning-scheduler / Claude CLI subprocess',
      when: completedTs,
      why: `Cron schedule "${job.schedule}" (${scheduleDesc}) — autonomous maintenance task`,
      how: `Claude ${job.model} model. Duration: ${durationSec}. Exit code: ${statusResult.exitCode ?? 'N/A'}`,
    }),
    `Jane's scheduler completed the "${job.name}" job (${statusResult.success ? 'success' : 'failure'})`,
    completedTs,
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
  console.log('Jane Task Scheduler (direct Claude execution)');
  console.log('='.repeat(70));
  console.log(`Started: ${startTimePacific}`);
  console.log(`Timezone: ${TIMEZONE}`);
  console.log(`Claude: @jane-core/claude-launcher`);
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

  // Graceful shutdown
  const shutdown = (signal) => {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`Received ${signal}, shutting down scheduler...`);
    console.log('='.repeat(70));
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
  });
}

startScheduler();

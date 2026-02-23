#!/usr/bin/env node

const cron = require('node-cron');
const fs = require('fs').promises;
const path = require('path');

// Webhook configuration
const WEBHOOK_URL = 'http://life-system-n8n:5678/webhook/jane/simple-stimulation/response';

// Cron schedule: Every day at 8:00 AM Pacific Time
const SCHEDULE = '0 8 * * *';
const TIMEZONE = 'America/Los_Angeles';

// Status file path
const STATUS_FILE = path.join(__dirname, 'good-morning-scheduler', 'last-run.json');

/**
 * Write status file with last run information
 */
async function writeStatusFile(result) {
  try {
    // Ensure directory exists
    const statusDir = path.dirname(STATUS_FILE);
    await fs.mkdir(statusDir, { recursive: true });

    // Write status
    await fs.writeFile(STATUS_FILE, JSON.stringify(result, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to write status file:', error.message);
  }
}

/**
 * Send good morning message via webhook
 */
async function sendGoodMorningMessage() {
  const now = new Date();
  const timestamp = now.toLocaleString('en-US', {
    timeZone: TIMEZONE,
    dateStyle: 'full',
    timeStyle: 'long'
  });

  console.log(`[${timestamp}] Sending good morning message...`);

  const statusResult = {
    timestamp: now.toISOString(),
    timestampPacific: timestamp,
    success: false,
    error: null,
    responseStatus: null,
    responseData: null
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'Good morning! Have a great day!'
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const responseData = await response.json().catch(() => null);

    console.log(`[${timestamp}] ✓ Message sent successfully`);
    console.log(`[${timestamp}] Response status: ${response.status}`);
    if (responseData) {
      console.log(`[${timestamp}] Response data:`, JSON.stringify(responseData));
    }

    // Update status result
    statusResult.success = response.ok;
    statusResult.responseStatus = response.status;
    statusResult.responseData = responseData;
  } catch (error) {
    // Log error but don't crash the process
    console.error(`[${timestamp}] ✗ Failed to send message:`);
    if (error.name === 'AbortError') {
      console.error(`[${timestamp}]   Request timeout (10 seconds)`);
      statusResult.error = 'Request timeout (10 seconds)';
    } else {
      console.error(`[${timestamp}]   Error:`, error.message);
      statusResult.error = error.message;
    }
  }

  // Write status file after each execution
  await writeStatusFile(statusResult);
}

/**
 * Calculate next scheduled run time
 */
function getNextRunTime() {
  const now = new Date();
  const pacificNow = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }));

  // Create next 8:00 AM Pacific time
  const next8AM = new Date(pacificNow);
  next8AM.setHours(8, 0, 0, 0);

  // If we're past 8 AM today, schedule for tomorrow
  if (pacificNow.getHours() >= 8) {
    next8AM.setDate(next8AM.getDate() + 1);
  }

  return next8AM.toLocaleString('en-US', {
    timeZone: TIMEZONE,
    dateStyle: 'full',
    timeStyle: 'long'
  });
}

/**
 * Initialize the scheduler
 */
function startScheduler() {
  const startTime = new Date();
  const nextRun = getNextRunTime();

  // Heartbeat log on startup
  console.log('='.repeat(70));
  console.log('Good Morning Auto-Scheduler');
  console.log('='.repeat(70));
  console.log(`Schedule: ${SCHEDULE} (${TIMEZONE})`);
  console.log(`Webhook: ${WEBHOOK_URL}`);
  console.log(`Started at: ${startTime.toISOString()}`);
  console.log(`Next scheduled run: ${nextRun}`);
  console.log('='.repeat(70));

  // Schedule the cron job
  const task = cron.schedule(SCHEDULE, sendGoodMorningMessage, {
    timezone: TIMEZONE,
    scheduled: true
  });

  console.log('✓ Scheduler initialized successfully');
  console.log('Process will continue running... Press Ctrl+C to stop.');
  console.log('='.repeat(70));

  // Keep the process alive
  process.on('SIGINT', () => {
    console.log('\n' + '='.repeat(70));
    console.log('Shutting down scheduler...');
    task.stop();
    console.log('✓ Scheduler stopped');
    console.log('='.repeat(70));
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n' + '='.repeat(70));
    console.log('Received SIGTERM, shutting down...');
    task.stop();
    console.log('✓ Scheduler stopped');
    console.log('='.repeat(70));
    process.exit(0);
  });

  // Log unhandled rejections but don't crash
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    console.error('Process will continue running...');
  });
}

// Start the scheduler
startScheduler();

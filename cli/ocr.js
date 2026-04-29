#!/usr/bin/env node
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PRINTED_RECEIPT_PROMPT, HANDWRITTEN_NOTE_PROMPT } from './prompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Load .env manually (works across all Node versions and environments)
try {
  const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch { /* no .env file — rely on system env */ }

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Known sample types — update as new samples are added
const SAMPLES = [
  { file: '20260429_090654.jpg', type: 'printed' },
  { file: '20260429_105502.jpg', type: 'handwritten' },
  { file: '20260429_105517.jpg', type: 'handwritten' },
  { file: '20260429_105606.jpg', type: 'handwritten' },
  { file: '20260429_105805.jpg', type: 'printed' },
];

async function extractFromImage(imagePath, type) {
  const imageData = fs.readFileSync(imagePath);
  const base64 = imageData.toString('base64');
  const ext = path.extname(imagePath).toLowerCase();
  const mediaType = ext === '.png' ? 'image/png' : 'image/jpeg';
  const prompt = type === 'printed' ? PRINTED_RECEIPT_PROMPT : HANDWRITTEN_NOTE_PROMPT;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  const raw = response.content[0].text.trim();

  // Strip markdown code fences if Claude adds them
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  const result = JSON.parse(cleaned);

  // Sanitise impossible time values (e.g. "09:81") — null them so the UI prompts correction
  if (result.time) {
    const [h, m] = result.time.split(':').map(Number);
    if (isNaN(h) || isNaN(m) || h > 23 || m > 59) {
      result.time = null;
      result.confidence = { ...result.confidence, time: 'low' };
    }
  }

  return result;
}

function printResult(file, type, result, elapsed) {
  const sep = '─'.repeat(60);
  console.log(`\n${sep}`);
  console.log(`FILE : ${file}`);
  console.log(`TYPE : ${type}  |  ${elapsed}ms`);
  console.log(sep);
  console.log(JSON.stringify(result, null, 2));
}

async function runSingle(imagePath, type) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set. Copy .env.example to .env and add your key.');
    process.exit(1);
  }
  const t0 = Date.now();
  const result = await extractFromImage(imagePath, type);
  printResult(path.basename(imagePath), type, result, Date.now() - t0);
}

async function runAllSamples() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set. Copy .env.example to .env and add your key.');
    process.exit(1);
  }

  console.log('Oloolua Hardware — OCR Phase 1 Validation');
  console.log(`Running ${SAMPLES.length} samples against claude-sonnet-4-6\n`);

  const errors = [];
  for (const sample of SAMPLES) {
    const imagePath = path.join(ROOT, 'samples', sample.file);
    if (!fs.existsSync(imagePath)) {
      console.warn(`SKIP: ${sample.file} — file not found`);
      continue;
    }
    try {
      const t0 = Date.now();
      const result = await extractFromImage(imagePath, sample.type);
      printResult(sample.file, sample.type, result, Date.now() - t0);
    } catch (err) {
      console.error(`\nERROR on ${sample.file}: ${err.message}`);
      errors.push({ file: sample.file, error: err.message });
    }
  }

  if (errors.length) {
    console.log('\n\nFailed samples:');
    errors.forEach(e => console.log(`  ${e.file}: ${e.error}`));
    process.exit(1);
  } else {
    console.log('\n\nAll samples processed successfully.');
  }
}

// CLI usage:
//   node cli/ocr.js                              → run all samples
//   node cli/ocr.js <image-path> <printed|handwritten>  → run single image
const args = process.argv.slice(2);
if (args.length === 0) {
  runAllSamples();
} else if (args.length === 2) {
  const [imgPath, type] = args;
  if (!['printed', 'handwritten'].includes(type)) {
    console.error('Type must be "printed" or "handwritten"');
    process.exit(1);
  }
  runSingle(path.resolve(imgPath), type);
} else {
  console.error('Usage: node cli/ocr.js [<image-path> <printed|handwritten>]');
  process.exit(1);
}

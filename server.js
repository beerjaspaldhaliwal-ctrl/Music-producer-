import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, buildFirstTurn } from './server/prompt.js';

try { process.loadEnvFile(); } catch { /* no .env file — rely on the environment */ }

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.COPRODUCER_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.COPRODUCER_EFFORT || 'high';

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(here, 'public')));

let client = null;
const getClient = () => (client ??= new Anthropic());

app.get('/api/status', (_req, res) => {
  res.json({
    aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    model: MODEL,
  });
});

/**
 * Streams a co-producer turn as Server-Sent Events.
 * Body: { history: MessageParam[], start?: {...first-session payload}, message?: string }
 * Events: thinking {text}, text {text}, done {userMessage, assistantContent, stopReason}, error {message}
 */
app.post('/api/coproduce', async (req, res) => {
  const { history = [], start, message } = req.body || {};
  let userMessage;
  if (start) {
    const content = [];
    if (start.spectrogramPng?.startsWith('data:image/png;base64,')) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: start.spectrogramPng.slice('data:image/png;base64,'.length) },
      });
    }
    content.push({ type: 'text', text: buildFirstTurn(start) });
    userMessage = { role: 'user', content };
  } else if (typeof message === 'string' && message.trim()) {
    userMessage = { role: 'user', content: message.trim() };
  } else {
    return res.status(400).json({ error: 'Send either `start` (first session) or a non-empty `message`.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let stream;
  res.on('close', () => { if (!res.writableFinished) stream?.abort(); });

  try {
    stream = getClient().beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: EFFORT },
      cache_control: { type: 'ephemeral' },
      system: SYSTEM_PROMPT,
      messages: [...history, userMessage],
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });

    for await (const event of stream) {
      if (event.type !== 'content_block_delta') continue;
      if (event.delta.type === 'text_delta') send('text', { text: event.delta.text });
      else if (event.delta.type === 'thinking_delta') send('thinking', { text: event.delta.thinking });
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      send('error', { message: 'The AI declined this request. Try rephrasing your brief or notes.' });
    } else {
      send('done', { userMessage, assistantContent: final.content, stopReason: final.stop_reason });
    }
  } catch (err) {
    send('error', { message: describeError(err) });
  } finally {
    res.end();
  }
});

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'No valid Anthropic API key. Add ANTHROPIC_API_KEY to a .env file next to server.js and restart (see README).';
  }
  if (err instanceof Anthropic.PermissionDeniedError) return `Your API key can't use ${MODEL}: ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the Anthropic API — wait a minute and try again.';
  if (err instanceof Anthropic.BadRequestError) return `Request rejected: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API. Check your internet connection.';
  if (err instanceof Anthropic.APIError) return `Anthropic API error (${err.status ?? 'unknown'}): ${err.message}`;
  if (err?.message?.includes('Could not resolve authentication method')) {
    return 'No Anthropic API key found. Add ANTHROPIC_API_KEY to a .env file next to server.js and restart (see README).';
  }
  return err?.message || String(err);
}

app.listen(PORT, () => {
  console.log(`\n🎛️  Pop Co-Producer running at http://localhost:${PORT}\n`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log('   (No ANTHROPIC_API_KEY set — analysis & Splice picks work, AI co-producer chat needs a key.)\n');
  }
});

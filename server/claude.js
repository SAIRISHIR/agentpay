const Anthropic = require('@anthropic-ai/sdk');
const { ANTHROPIC_API_KEY, MODEL } = require('./config');

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Haiku occasionally returns no text block; read every text block and retry an empty reply.
async function ask(instructions, input, { maxTokens = 2000 } = {}, attempt = 1) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: `${instructions}\n\n---\n${input}` }],
  });
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (text) return text;
  if (attempt < 3) return ask(instructions, input, { maxTokens }, attempt + 1);
  throw new Error(`Model returned no text (stop_reason: ${msg.stop_reason})`);
}

function parseJson(text) {
  const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('Reply was not JSON');
  }
}

module.exports = { client, ask, parseJson, MODEL };

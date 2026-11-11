const { SKILLS } = require('./skills');
const { ask, parseJson } = require('./claude');

// Escrow arbiter: a cheap schema check first, then an AI check that the work actually fits the input.
async function verify(service, input, output) {
  const skill = SKILLS[service.skill];
  const schemaError = skill.validate(output);
  if (schemaError) return { pass: false, score: 0, reason: schemaError, method: 'schema' };

  const instructions = `You are the escrow verifier for an AI-services marketplace. Money is released to the seller only if the delivery meets the contract.
Service: ${skill.name}
Contract: ${skill.description}
Fail the delivery if it is generic, does not reflect the input, contradicts the input, or ignores the contract.
Reply with JSON only: {"pass":true|false,"score":0.0-1.0,"reason":"at most 20 words, plain language"}`;

  const raw = await ask(instructions, `INPUT:\n${input.slice(0, 3000)}\n\nDELIVERY:\n${JSON.stringify(output).slice(0, 3000)}`, { maxTokens: 1500 });
  let v;
  try { v = parseJson(raw); } catch { return { pass: false, score: 0, reason: 'Verifier reply could not be read, so funds were returned', method: 'ai' }; }
  const score = Math.min(1, Math.max(0, Number(v.score) || 0));
  return { pass: v.pass === true, score, reason: String(v.reason || '').slice(0, 240), method: 'ai' };
}

// Owner dispute: re-review a released delivery with the owner's complaint. Upheld means clawback.
async function reviewDispute(service, input, output, complaint) {
  const skill = SKILLS[service.skill];
  const instructions = `You are the dispute reviewer for an AI-services marketplace. The buyer's owner disputes a delivery that was already approved.
Service: ${skill.name}
Contract: ${skill.description}
Owner's complaint: "${complaint.slice(0, 500)}"
Uphold the dispute only if the complaint is valid: the delivery is wrong, misleading, incomplete or breaks the contract in the way the owner describes. Reject complaints that are unfounded or ask for things the contract never promised.
Reply with JSON only: {"upheld":true|false,"reason":"at most 25 words, plain language, addressed to the owner"}`;
  const raw = await ask(instructions, `INPUT:\n${input.slice(0, 3000)}\n\nDELIVERY:\n${JSON.stringify(output).slice(0, 3000)}`, { maxTokens: 1500 });
  let v;
  try { v = parseJson(raw); } catch { return { upheld: false, reason: 'The reviewer could not reach a decision. The payment stays released; you can dispute again.' }; }
  return { upheld: v.upheld === true, reason: String(v.reason || '').slice(0, 240) };
}

module.exports = { verify, reviewDispute };

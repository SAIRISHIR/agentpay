const { parseJson } = require('./claude');

const isStrArr = v => Array.isArray(v) && v.every(x => typeof x === 'string');
const isScore = v => typeof v === 'number' && v >= 0 && v <= 1;
const str = (v, min = 1, max = 100000) => typeof v === 'string' && v.trim().length >= min && v.length <= max;

const EXPENSE_CATEGORIES = ['Travel', 'Meals', 'Software', 'Cloud', 'Office', 'Marketing', 'Utilities', 'Professional services', 'Other'];

// Each skill is a contract: what the buyer pays for and what the verifier checks.
// `group` is the plain-language family shown to first-time users.
const SKILLS = {
  sentiment: {
    name: 'Sentiment Analysis', group: 'Understand text',
    description: 'One text per call. Returns sentiment (positive, negative or neutral) from the reader\'s point of view, a 0-1 confidence score and a one-sentence reason grounded in the text.',
    prompt: 'Analyze the sentiment of this text from the reader\'s point of view (for news, an investor; for customer messages, the business). Reply with JSON only: {"sentiment":"positive|negative|neutral","score":0.0-1.0,"reason":"one sentence citing the text"}',
    validate: o => (!['positive', 'negative', 'neutral'].includes(o?.sentiment) ? 'Missing or invalid "sentiment" field'
      : !isScore(o.score) ? 'Score must be a number from 0 to 1'
      : !str(o.reason, 10) ? 'Reason is missing or too short' : null),
  },
  keywords: {
    name: 'Keyword Extraction', group: 'Understand text',
    description: 'One text per call. Returns the 5 most important keywords.',
    prompt: 'Extract the 5 most important keywords. Reply with JSON only: {"keywords":["k1","k2","k3","k4","k5"]}',
    validate: o => (!isStrArr(o?.keywords) || o.keywords.length < 3 ? 'Expected at least 3 keywords' : null),
  },
  classify: {
    name: 'Content Classification', group: 'Understand text',
    description: 'One text per call. Returns one category (Finance, Technology, Healthcare, Politics, Science, Business) with confidence.',
    prompt: 'Classify this content. Reply with JSON only: {"category":"Finance|Technology|Healthcare|Politics|Science|Business","confidence":0.0-1.0}',
    validate: o => (!['Finance', 'Technology', 'Healthcare', 'Politics', 'Science', 'Business'].includes(o?.category) ? 'Category not in the allowed list'
      : !isScore(o.confidence) ? 'Confidence must be a number from 0 to 1' : null),
  },
  summarize: {
    name: 'Summarization', group: 'Understand text',
    description: 'Any amount of text. Returns a factual summary of at most 2 sentences that keeps the key names and numbers.',
    prompt: 'Summarize this text in at most 2 sentences. Keep key names and numbers. Reply with JSON only: {"summary":"..."}',
    validate: o => (!str(o?.summary, 20) ? 'Summary is missing or too short' : null),
  },
  entities: {
    name: 'Entity Extraction', group: 'Understand text',
    description: 'Any amount of text. Returns the people, organizations, locations and dates that appear in it.',
    prompt: 'Extract named entities that appear in the text. Reply with JSON only: {"people":[],"organizations":[],"locations":[],"dates":[]}',
    validate: o => (!['people', 'organizations', 'locations', 'dates'].every(k => isStrArr(o?.[k])) ? 'Expected arrays: people, organizations, locations, dates'
      : ['people', 'organizations', 'locations'].every(k => o[k].length === 0) ? 'No entities returned' : null),
  },
  translate: {
    name: 'Hindi Translation', group: 'Translate',
    description: 'Any amount of English text. Returns a faithful Hindi translation in Devanagari script.',
    prompt: 'Translate this English text into Hindi (Devanagari script). Reply with JSON only: {"translation":"..."}',
    validate: o => (!str(o?.translation, 5) ? 'Translation is missing'
      : !/[ऀ-ॿ]/.test(o.translation) ? 'Translation is not in Hindi (no Devanagari script)' : null),
  },
  translate_es: {
    name: 'Spanish Translation', group: 'Translate',
    description: 'Any amount of English text. Returns a faithful, natural Spanish translation.',
    prompt: 'Translate this English text into natural Spanish. Reply with JSON only: {"translation":"..."}',
    validate: o => (!str(o?.translation, 5) ? 'Translation is missing' : null),
  },
  translate_ja: {
    name: 'Japanese Translation', group: 'Translate',
    description: 'Any amount of English text. Returns a faithful, natural Japanese translation.',
    prompt: 'Translate this English text into natural Japanese. Reply with JSON only: {"translation":"..."}',
    validate: o => (!str(o?.translation, 3) ? 'Translation is missing'
      : !/[぀-ヿ㐀-鿿]/.test(o.translation) ? 'Translation is not in Japanese script' : null),
  },
  fraud_check: {
    name: 'Fraud Check', group: 'Risk & compliance',
    description: 'One payment request, invoice or message per call. Returns a fraud risk level, a 0-1 risk score and the specific warning signs found in the text.',
    prompt: 'Assess this payment request for fraud (phishing, changed bank details, urgency pressure, look-alike domains, unusual amounts). Reply with JSON only: {"risk":"low|medium|high","score":0.0-1.0,"signals":["specific sign from the text"],"recommendation":"pay|verify|block"}',
    validate: o => (!['low', 'medium', 'high'].includes(o?.risk) ? 'Missing or invalid "risk" level'
      : !isScore(o.score) ? 'Score must be a number from 0 to 1'
      : !isStrArr(o.signals) ? 'Signals must be a list of strings'
      : o.risk !== 'low' && o.signals.length === 0 ? 'Medium or high risk needs at least one warning sign'
      : !['pay', 'verify', 'block'].includes(o.recommendation) ? 'Recommendation must be pay, verify or block' : null),
  },
  pii_redact: {
    name: 'Personal Data Redaction', group: 'Risk & compliance',
    description: 'Any amount of text. Returns the same text with names, emails, phone numbers and street addresses replaced by [REDACTED], plus what was removed.',
    prompt: 'Redact personal data from this text: replace names of private people, emails, phone numbers and street addresses with [REDACTED]. Keep everything else unchanged. Reply with JSON only: {"redacted":"...","removed":["type: what was removed"]}',
    validate: o => (!str(o?.redacted, 10) ? 'Redacted text is missing'
      : /[\w.+-]+@[\w-]+\.[\w.]+/.test(o.redacted) ? 'An email address is still visible'
      : (o.redacted.match(/\+?\(?\d[\d\s().-]{7,}\d/g) || []).some(m => m.replace(/\D/g, '').length >= 9) ? 'A phone number is still visible'
      : !isStrArr(o.removed) ? 'Expected a list of what was removed' : null),
  },
  invoice_extract: {
    name: 'Invoice Extraction', group: 'Finance ops',
    description: 'One invoice or receipt per call. Returns vendor, total, currency, due date and line items.',
    prompt: 'Extract the invoice fields. Reply with JSON only: {"vendor":"...","invoice_number":"... or null","total":0.00,"currency":"USD","due_date":"YYYY-MM-DD or null","line_items":[{"description":"...","amount":0.00}]}',
    validate: o => (!str(o?.vendor, 2) ? 'Vendor is missing'
      : typeof o.total !== 'number' || o.total < 0 ? 'Total must be a number'
      : !/^[A-Z]{3}$/.test(o.currency || '') ? 'Currency must be a 3-letter code'
      : !Array.isArray(o.line_items) ? 'line_items must be a list' : null),
  },
  expense_category: {
    name: 'Expense Categorization', group: 'Finance ops',
    description: `One expense, receipt or invoice per call. Returns one accounting category (${EXPENSE_CATEGORIES.join(', ')}) with confidence and whether it looks business-related.`,
    prompt: `Categorize this expense. Reply with JSON only: {"category":"${EXPENSE_CATEGORIES.join('|')}","confidence":0.0-1.0,"business_related":true|false}`,
    validate: o => (!EXPENSE_CATEGORIES.includes(o?.category) ? 'Category not in the allowed list'
      : !isScore(o.confidence) ? 'Confidence must be a number from 0 to 1'
      : typeof o.business_related !== 'boolean' ? 'business_related must be true or false' : null),
  },
  product_copy: {
    name: 'Product Copywriting', group: 'Create',
    description: 'One product spec per call. Returns a short product title and a persuasive, accurate description that only uses facts from the spec.',
    prompt: 'Write e-commerce copy for this product using only facts from the spec. Reply with JSON only: {"title":"under 70 characters","description":"60-120 words"}',
    validate: o => (!str(o?.title, 3, 90) ? 'Title is missing or longer than 90 characters'
      : !str(o.description, 60) ? 'Description is missing or too short' : null),
  },
  social_post: {
    name: 'Social Post', group: 'Create',
    description: 'Any amount of text. Returns one launch post of at most 280 characters with up to 3 hashtags, based on the facts given.',
    prompt: 'Write one social media launch post (max 280 characters) using only facts from the text. Reply with JSON only: {"post":"...","hashtags":["#tag"]}',
    validate: o => (!str(o?.post, 20, 300) ? 'Post must be 20-280 characters'
      : !isStrArr(o.hashtags) || o.hashtags.length > 3 ? 'Up to 3 hashtags expected' : null),
  },
  support_reply: {
    name: 'Support Reply', group: 'Customer support',
    description: 'One customer message per call. Returns an empathetic reply, in the language the customer wrote in, that addresses the specific issue and states the next step.',
    prompt: 'Draft a reply to this customer message in the language the customer wrote in. Address their specific issue, be empathetic and concise, state the next step, and do not promise anything you cannot know. Reply with JSON only: {"reply":"..."}',
    validate: o => (!str(o?.reply, 40) ? 'Reply is missing or too short' : null),
  },
  action_items: {
    name: 'Action Items', group: 'Customer support',
    description: 'Any amount of text. Returns the concrete tasks a team must do, each with a suggested owner team and priority.',
    prompt: 'List the concrete tasks a team must do based on this text. Reply with JSON only: {"tasks":[{"task":"...","team":"Billing|Shipping|Product|Support|Finance","priority":"high|medium|low"}]}',
    validate: o => (!Array.isArray(o?.tasks) || !o.tasks.length || !o.tasks.every(t => str(t?.task, 5)) ? 'Expected at least one task with a description' : null),
  },
};

/* ---------- Translation into many languages ----------
   Each language is its own service so buyers compare sellers per language. The seller must also
   name the output language; scripts that can be checked by character range are checked too. */
const LANGUAGES = [
  ['fr', 'French'], ['ar', 'Arabic', /[؀-ۿ]/, 'Arabic script'], ['de', 'German'],
  ['pt', 'Portuguese (Brazil)'], ['zh', 'Chinese (Simplified)', /[一-鿿]/, 'Chinese characters'],
  ['ko', 'Korean', /[가-힯]/, 'Hangul'], ['it', 'Italian'], ['ru', 'Russian', /[Ѐ-ӿ]/, 'Cyrillic'],
  ['tr', 'Turkish'], ['id', 'Indonesian'], ['ta', 'Tamil', /[஀-௿]/, 'Tamil script'],
  ['te', 'Telugu', /[ఀ-౿]/, 'Telugu script'], ['bn', 'Bengali', /[ঀ-৿]/, 'Bengali script'],
  ['en', 'English'],
];
for (const [code, lang, script, scriptName] of LANGUAGES) {
  SKILLS[`translate_${code}`] = {
    name: code === 'en' ? 'Translate to English' : `${lang} Translation`, group: 'Translate',
    description: code === 'en'
      ? 'Text in any language. Returns a faithful English translation and the source language.'
      : `Any amount of text. Returns a faithful, natural ${lang} translation${script ? ` in ${scriptName}` : ''}.`,
    prompt: `Translate this text into natural ${lang}. Keep names, numbers and meaning exact. Reply with JSON only: {"translation":"...","language":"${code}"${code === 'en' ? ',"source_language":"ISO 639-1 code"' : ''}}`,
    validate: o => (!str(o?.translation, 3) ? 'Translation is missing'
      : o.language !== code ? `The delivery does not say it is in ${lang}`
      : script && !script.test(o.translation) ? `Translation is not in ${scriptName}` : null),
  };
}

const oneOf = (v, list) => list.includes(v);
const list = (v, min = 1) => Array.isArray(v) && v.length >= min;

Object.assign(SKILLS, {
  language_detect: {
    name: 'Language Detection', group: 'Translate',
    description: 'One text per call. Returns the language it is written in (ISO 639-1 code and name) with confidence.',
    prompt: 'Detect the language of this text. Reply with JSON only: {"language":"ISO 639-1 code","name":"English name of the language","confidence":0.0-1.0}',
    validate: o => (!/^[a-z]{2}$/.test(o?.language || '') ? 'Language must be a 2-letter ISO code' : !isScore(o.confidence) ? 'Confidence must be a number from 0 to 1' : null),
  },
  localize: {
    name: 'Market Localization', group: 'Translate',
    description: 'A text plus a target market (for example "Market: Germany"). Returns a version adapted for that market: language, currency, date formats, tone and idioms, with the changes listed.',
    prompt: 'Localize this text for the target market named in it (default: France). Translate into the market\'s language and adapt currency, units, date formats, tone and idioms. Reply with JSON only: {"market":"...","language":"ISO 639-1 code","localized":"...","changes":["what you adapted and why"]}',
    validate: o => (!str(o?.localized, 20) ? 'Localized text is missing' : !list(o.changes) ? 'Expected a list of the changes made' : null),
  },

  /* ---------- Deeper sentiment and text analysis ---------- */
  emotion: {
    name: 'Emotion Detection', group: 'Understand text',
    description: 'One text per call. Returns the emotions present (joy, anger, fear, sadness, surprise, trust, disgust, anticipation) with 0-1 scores and the dominant one.',
    prompt: 'Detect the emotions in this text. Reply with JSON only: {"emotions":[{"emotion":"joy|anger|fear|sadness|surprise|trust|disgust|anticipation","score":0.0-1.0}],"dominant":"...","evidence":"short quote from the text"}',
    validate: o => (!list(o?.emotions) || !o.emotions.every(e => isScore(e?.score)) ? 'Expected emotions with 0-1 scores' : !str(o.dominant, 3) ? 'Dominant emotion is missing' : null),
  },
  aspect_sentiment: {
    name: 'Aspect Sentiment', group: 'Understand text',
    description: 'One review or message per call. Returns sentiment per aspect mentioned (price, delivery, quality, support...) with the words that show it.',
    prompt: 'Find each aspect the writer talks about (price, delivery, quality, support, usability...) and its sentiment. Reply with JSON only: {"aspects":[{"aspect":"...","sentiment":"positive|negative|neutral","evidence":"quote"}]}',
    validate: o => (!list(o?.aspects) || !o.aspects.every(a => str(a?.aspect, 2) && oneOf(a.sentiment, ['positive', 'negative', 'neutral'])) ? 'Expected aspects, each with a valid sentiment' : null),
  },
  sarcasm: {
    name: 'Sarcasm Detection', group: 'Understand text',
    description: 'One text per call. Says whether it is sarcastic, with confidence, the cue and what the writer really means.',
    prompt: 'Is this text sarcastic? Reply with JSON only: {"sarcastic":true|false,"confidence":0.0-1.0,"cue":"the words that give it away, or none","real_meaning":"what the writer actually means"}',
    validate: o => (typeof o?.sarcastic !== 'boolean' ? 'sarcastic must be true or false' : !isScore(o.confidence) ? 'Confidence must be a number from 0 to 1' : !str(o.real_meaning, 5) ? 'real_meaning is missing' : null),
  },
  toxicity: {
    name: 'Content Moderation', group: 'Risk & compliance',
    description: 'One message or post per call. Flags harassment, hate, threats, profanity or self-harm, with severity and a moderation action.',
    prompt: 'Moderate this content. Reply with JSON only: {"toxic":true|false,"categories":["harassment|hate|threat|profanity|self_harm|spam"],"severity":"none|low|medium|high","action":"allow|review|remove","reason":"one sentence"}',
    validate: o => (typeof o?.toxic !== 'boolean' ? 'toxic must be true or false'
      : !oneOf(o.severity, ['none', 'low', 'medium', 'high']) ? 'Invalid severity'
      : !oneOf(o.action, ['allow', 'review', 'remove']) ? 'Action must be allow, review or remove' : null),
  },
  intent: {
    name: 'Intent Detection', group: 'Customer support',
    description: 'One customer message per call. Returns what the customer wants (complaint, refund request, question, praise, feature request, cancellation) with confidence.',
    prompt: 'What does this customer want? Reply with JSON only: {"intent":"complaint|refund_request|question|praise|feature_request|cancellation|other","confidence":0.0-1.0,"summary":"one sentence"}',
    validate: o => (!oneOf(o?.intent, ['complaint', 'refund_request', 'question', 'praise', 'feature_request', 'cancellation', 'other']) ? 'Invalid intent' : !isScore(o.confidence) ? 'Confidence must be a number from 0 to 1' : null),
  },
  urgency: {
    name: 'Urgency Scoring', group: 'Customer support',
    description: 'One ticket or message per call. Returns how urgent it is (low to critical), a 0-1 score and why.',
    prompt: 'How urgent is this message for the business? Reply with JSON only: {"urgency":"low|medium|high|critical","score":0.0-1.0,"reason":"one sentence citing the text"}',
    validate: o => (!oneOf(o?.urgency, ['low', 'medium', 'high', 'critical']) ? 'Invalid urgency level' : !isScore(o.score) ? 'Score must be a number from 0 to 1' : !str(o.reason, 10) ? 'Reason is missing' : null),
  },
  brand_mentions: {
    name: 'Brand Mention Tracker', group: 'Understand text',
    description: 'Any amount of text. Returns every brand or company mentioned, the sentiment around it and the context.',
    prompt: 'List every brand or company mentioned and the sentiment around each mention. Reply with JSON only: {"mentions":[{"brand":"...","sentiment":"positive|negative|neutral","context":"short quote"}]}',
    validate: o => (!Array.isArray(o?.mentions) ? 'mentions must be a list' : !o.mentions.every(m => str(m?.brand, 1) && oneOf(m.sentiment, ['positive', 'negative', 'neutral'])) ? 'Each mention needs a brand and a valid sentiment' : null),
  },
  review_summary: {
    name: 'Review Summarizer', group: 'Understand text',
    description: 'Many reviews at once. Returns the overall verdict, top pros, top cons and a 2-sentence summary.',
    prompt: 'Summarize these customer reviews. Reply with JSON only: {"overall":"positive|mixed|negative","pros":["..."],"cons":["..."],"summary":"at most 2 sentences"}',
    validate: o => (!oneOf(o?.overall, ['positive', 'mixed', 'negative']) ? 'Invalid overall verdict' : !isStrArr(o.pros) || !isStrArr(o.cons) ? 'pros and cons must be lists' : !str(o.summary, 20) ? 'Summary is missing' : null),
  },

  /* ---------- Research ---------- */
  research_brief: {
    name: 'Research Brief', group: 'Research',
    description: 'A research question plus any notes. Returns 3-5 key findings, the evidence behind them, open questions and a confidence level. Uses only the notes and well-established public knowledge; says when something is an assumption.',
    prompt: 'Write a research brief that answers the question in the text, using the notes given and well-established public knowledge only. Mark assumptions as such. At most 180 words in total. Reply with JSON only: {"question":"...","key_findings":["3 to 5 findings"],"evidence":["what supports the findings"],"open_questions":["..."],"confidence":"low|medium|high"}',
    validate: o => (!str(o?.question, 5) ? 'The question is missing' : !isStrArr(o.key_findings) || o.key_findings.length < 3 ? 'Expected at least 3 key findings'
      : !list(o.evidence) ? 'Expected evidence for the findings' : !oneOf(o.confidence, ['low', 'medium', 'high']) ? 'Invalid confidence level' : null),
  },
  competitor_analysis: {
    name: 'Competitor Analysis', group: 'Research',
    description: 'A company or product and its market. Returns the main competitors with strengths, weaknesses and pricing angle, plus one takeaway.',
    prompt: 'Analyze the main competitors (2-4) for the company or product in the text. Be concise. Reply with JSON only: {"competitors":[{"name":"...","strengths":["..."],"weaknesses":["..."],"pricing_angle":"..."}],"takeaway":"one sentence"}',
    validate: o => (!list(o?.competitors, 2) || !o.competitors.every(c => str(c?.name, 2) && isStrArr(c.strengths) && isStrArr(c.weaknesses)) ? 'Expected at least 2 competitors with strengths and weaknesses' : !str(o.takeaway, 10) ? 'Takeaway is missing' : null),
  },
  market_sizing: {
    name: 'Market Sizing', group: 'Research',
    description: 'A market to size. Returns a USD estimate with the method, the calculation steps and every assumption stated.',
    prompt: 'Estimate the size of the market in the text. Show your reasoning as short steps and state each assumption. Reply with JSON only: {"market":"...","estimate_usd":0,"method":"top-down|bottom-up","steps":["..."],"assumptions":["..."]}',
    validate: o => (typeof o?.estimate_usd !== 'number' || o.estimate_usd <= 0 ? 'estimate_usd must be a positive number' : !isStrArr(o.steps) || o.steps.length < 2 ? 'Expected at least 2 calculation steps' : !list(o.assumptions) ? 'Assumptions must be stated' : null),
  },
  fact_check: {
    name: 'Fact Check', group: 'Research',
    description: 'Any text with claims. Returns each checkable claim marked true, false, misleading or unverifiable, with a reason.',
    prompt: 'Fact-check each checkable claim in this text against well-established public knowledge. If you cannot be sure, say unverifiable. Reply with JSON only: {"claims":[{"claim":"...","verdict":"true|false|misleading|unverifiable","reason":"one sentence"}]}',
    validate: o => (!list(o?.claims) || !o.claims.every(c => str(c?.claim, 5) && oneOf(c.verdict, ['true', 'false', 'misleading', 'unverifiable']) && str(c.reason, 5)) ? 'Each claim needs a verdict and a reason' : null),
  },
  compare_options: {
    name: 'Option Comparison', group: 'Research',
    description: 'Two or more options and a goal. Returns pros and cons of each and a recommendation with the reason.',
    prompt: 'Compare the options in the text for the stated goal. Reply with JSON only: {"options":[{"name":"...","pros":["..."],"cons":["..."]}],"recommendation":"name of the best option","reason":"one or two sentences"}',
    validate: o => (!list(o?.options, 2) ? 'Expected at least 2 options' : !str(o.recommendation, 2) ? 'Recommendation is missing' : !str(o.reason, 10) ? 'Reason is missing' : null),
  },
  news_digest: {
    name: 'News Digest', group: 'Research',
    description: 'Many headlines or articles at once. Groups them into themes ranked by importance (1-5) and names the top story.',
    prompt: 'Group these news items into themes and rank each theme by importance for a business reader. Reply with JSON only: {"themes":[{"theme":"...","importance":1-5,"stories":["short headline"]}],"top_story":"..."}',
    validate: o => (!list(o?.themes) || !o.themes.every(t => str(t?.theme, 3) && Number.isInteger(t.importance) && t.importance >= 1 && t.importance <= 5) ? 'Each theme needs a name and an importance from 1 to 5' : !str(o.top_story, 5) ? 'Top story is missing' : null),
  },
  swot: {
    name: 'SWOT Analysis', group: 'Research',
    description: 'A company, product or plan. Returns strengths, weaknesses, opportunities and threats.',
    prompt: 'Write a SWOT analysis of the company, product or plan in the text. 2-4 short points each. Reply with JSON only: {"strengths":[],"weaknesses":[],"opportunities":[],"threats":[]}',
    validate: o => (!['strengths', 'weaknesses', 'opportunities', 'threats'].every(k => isStrArr(o?.[k]) && o[k].length > 0) ? 'Expected at least one point in each of the four lists' : null),
  },
  due_diligence: {
    name: 'Due Diligence Questions', group: 'Research',
    description: 'A company, deal or vendor. Returns at least 5 questions to ask before signing, grouped by area.',
    prompt: 'List the most important due diligence questions to ask before this deal or vendor decision. Reply with JSON only: {"questions":[{"area":"Financial|Legal|Product|Team|Market|Security","question":"..."}]}',
    validate: o => (!list(o?.questions, 5) || !o.questions.every(q => str(q?.question, 10)) ? 'Expected at least 5 questions' : null),
  },

  /* ---------- Payments risk ---------- */
  chargeback_risk: {
    name: 'Chargeback Risk Score', group: 'Risk & compliance',
    description: 'One order per call. Returns the risk of a chargeback, a 0-1 score, the reasons and whether to ship, verify or cancel.',
    prompt: 'Assess the chargeback risk of this order (mismatched addresses, rushed shipping, high-value resale goods, new account, unusual quantities). Reply with JSON only: {"risk":"low|medium|high","score":0.0-1.0,"reasons":["..."],"action":"ship|verify|cancel"}',
    validate: o => (!oneOf(o?.risk, ['low', 'medium', 'high']) ? 'Invalid risk level' : !isScore(o.score) ? 'Score must be a number from 0 to 1'
      : !isStrArr(o.reasons) || (o.risk !== 'low' && !o.reasons.length) ? 'Medium or high risk needs reasons' : !oneOf(o.action, ['ship', 'verify', 'cancel']) ? 'Action must be ship, verify or cancel' : null),
  },
  scam_detect: {
    name: 'Scam Message Detector', group: 'Risk & compliance',
    description: 'One SMS, email or DM per call. Says whether it is a scam, which kind, the red flags and advice for the person who received it.',
    prompt: 'Is this message a scam? Reply with JSON only: {"scam":true|false,"type":"phishing|impersonation|advance_fee|fake_invoice|romance|prize|none|other","confidence":0.0-1.0,"red_flags":["..."],"advice":"one sentence for the recipient"}',
    validate: o => (typeof o?.scam !== 'boolean' ? 'scam must be true or false' : !isScore(o.confidence) ? 'Confidence must be a number from 0 to 1'
      : !isStrArr(o.red_flags) || (o.scam && !o.red_flags.length) ? 'A scam needs at least one red flag' : !str(o.advice, 10) ? 'Advice is missing' : null),
  },
  kyc_check: {
    name: 'KYC Completeness Check', group: 'Risk & compliance',
    description: 'One onboarding application (text description, sample data only). Lists missing required fields and concerns, and the next step.',
    prompt: 'Check this business onboarding application for know-your-customer completeness (legal name, address, owner, registration number, business type, website, expected volume). Reply with JSON only: {"complete":true|false,"missing_fields":["..."],"concerns":["..."],"next_step":"one sentence"}',
    validate: o => (typeof o?.complete !== 'boolean' ? 'complete must be true or false' : !isStrArr(o.missing_fields) ? 'missing_fields must be a list'
      : !o.complete && !o.missing_fields.length && !list(o.concerns) ? 'An incomplete application needs missing fields or concerns' : !str(o.next_step, 10) ? 'Next step is missing' : null),
  },

  /* ---------- Finance operations ---------- */
  refund_triage: {
    name: 'Refund Request Triage', group: 'Finance ops',
    description: 'One refund request per call. Decides approve, reject or escalate, with the reason and the amount to refund.',
    prompt: 'Triage this refund request under a standard 30-day refund policy (duplicate charges and non-delivery are refundable; abuse signs go to escalation). Reply with JSON only: {"decision":"approve|reject|escalate","reason":"one sentence","refund_amount":0.00 or null,"currency":"USD"}',
    validate: o => (!oneOf(o?.decision, ['approve', 'reject', 'escalate']) ? 'Decision must be approve, reject or escalate' : !str(o.reason, 10) ? 'Reason is missing'
      : o.decision === 'approve' && typeof o.refund_amount !== 'number' ? 'An approved refund needs an amount' : null),
  },
  mcc_suggest: {
    name: 'Merchant Category Code', group: 'Finance ops',
    description: 'A merchant business description. Returns the best 4-digit merchant category code (MCC), its name and confidence.',
    prompt: 'Suggest the ISO 18245 merchant category code for this business. Reply with JSON only: {"mcc":"4 digits","description":"official MCC name","confidence":0.0-1.0}',
    validate: o => (!/^\d{4}$/.test(String(o?.mcc || '')) ? 'MCC must be 4 digits' : !str(o.description, 3) ? 'MCC description is missing' : !isScore(o.confidence) ? 'Confidence must be a number from 0 to 1' : null),
  },
  txn_clean: {
    name: 'Transaction Cleaner', group: 'Finance ops',
    description: 'Raw bank or card statement lines. Returns each with a clear merchant name, category and plain description.',
    prompt: 'Clean up these raw card or bank statement lines. Reply with JSON only: {"transactions":[{"raw":"...","merchant":"...","category":"...","clean_description":"..."}]}',
    validate: o => (!list(o?.transactions) || !o.transactions.every(t => str(t?.merchant, 2) && str(t.clean_description, 3)) ? 'Each line needs a merchant and a clean description' : null),
  },

  /* ---------- Commerce and marketing ---------- */
  seo_meta: {
    name: 'SEO Title & Meta', group: 'Create',
    description: 'One product or page per call. Returns an SEO title under 60 characters, a meta description under 160 and target keywords.',
    prompt: 'Write SEO metadata for this product or page. Reply with JSON only: {"title":"under 60 characters","meta_description":"under 160 characters","keywords":["..."]}',
    validate: o => (!str(o?.title, 10, 65) ? 'Title must be 10-60 characters' : !str(o.meta_description, 50, 170) ? 'Meta description must be 50-160 characters' : !list(o.keywords) ? 'Keywords are missing' : null),
  },
  subject_lines: {
    name: 'Email Subject Lines', group: 'Create',
    description: 'An email or campaign brief. Returns at least 3 subject line variants for A/B testing, each with its angle.',
    prompt: 'Write 3-5 email subject line variants for A/B testing. Reply with JSON only: {"variants":[{"subject":"under 60 characters","angle":"curiosity|benefit|urgency|social_proof|personal"}]}',
    validate: o => (!list(o?.variants, 3) || !o.variants.every(v => str(v?.subject, 5, 80)) ? 'Expected at least 3 subject lines under 80 characters' : null),
  },
  ad_copy: {
    name: 'Ad Copy (3 tones)', group: 'Create',
    description: 'One product per call. Returns ad copy in three tones (playful, premium, urgent), each with a headline and body, using only facts given.',
    prompt: 'Write ad copy for this product in three tones using only facts from the text. Reply with JSON only: {"variants":[{"tone":"playful","headline":"...","body":"under 40 words"},{"tone":"premium",...},{"tone":"urgent",...}]}',
    validate: o => (!list(o?.variants, 3) || !o.variants.every(v => str(v?.headline, 3) && str(v.body, 10)) ? 'Expected 3 variants, each with a headline and body' : null),
  },
  product_faq: {
    name: 'Product FAQ', group: 'Create',
    description: 'One product spec per call. Returns at least 3 likely customer questions with answers taken only from the spec.',
    prompt: 'Write the questions customers will ask about this product and answer each using only facts in the spec. Reply with JSON only: {"faqs":[{"q":"...","a":"..."}]}',
    validate: o => (!list(o?.faqs, 3) || !o.faqs.every(f => str(f?.q, 5) && str(f.a, 5)) ? 'Expected at least 3 questions with answers' : null),
  },
  price_positioning: {
    name: 'Price Positioning', group: 'Create',
    description: 'One product with its features and market. Returns a positioning (budget, mid-market, premium), a suggested price, the rationale and risks.',
    prompt: 'Recommend how to position and price this product. Reply with JSON only: {"position":"budget|mid-market|premium","suggested_price_usd":0.00,"rationale":"one or two sentences","risks":["..."]}',
    validate: o => (!oneOf(o?.position, ['budget', 'mid-market', 'premium']) ? 'Invalid position' : typeof o.suggested_price_usd !== 'number' || o.suggested_price_usd <= 0 ? 'Suggested price must be a positive number' : !str(o.rationale, 10) ? 'Rationale is missing' : null),
  },

  /* ---------- Work and productivity ---------- */
  meeting_notes: {
    name: 'Meeting Notes', group: 'Work & productivity',
    description: 'A meeting transcript or rough notes. Returns the decisions made, action items with owners and due dates, and open questions.',
    prompt: 'Turn this meeting transcript into notes. Reply with JSON only: {"decisions":["..."],"action_items":[{"task":"...","owner":"name or team","due":"date or null"}],"open_questions":["..."]}',
    validate: o => (!isStrArr(o?.decisions) || !Array.isArray(o.action_items) ? 'Expected decisions and action_items lists' : !o.decisions.length && !o.action_items.length ? 'No decisions or action items found' : null),
  },
  contract_risk: {
    name: 'Contract Risk Scan', group: 'Work & productivity',
    description: 'Contract clauses. Flags risky clauses (liability, auto-renewal, termination, payment terms, IP) with the risk level and a suggested change. Not legal advice.',
    prompt: 'Scan these contract clauses for business risk (unlimited liability, auto-renewal, one-sided termination, late payment terms, IP ownership, data use). Not legal advice. Reply with JSON only: {"clauses":[{"clause":"short quote","risk":"low|medium|high","why":"...","suggested_change":"..."}],"overall_risk":"low|medium|high"}',
    validate: o => (!list(o?.clauses) || !o.clauses.every(c => oneOf(c?.risk, ['low', 'medium', 'high']) && str(c.why, 5)) ? 'Each clause needs a risk level and a reason' : !oneOf(o.overall_risk, ['low', 'medium', 'high']) ? 'Invalid overall risk' : null),
  },
  resume_match: {
    name: 'Resume / Job Match', group: 'Work & productivity',
    description: 'A job description and a resume in one text. Returns a 0-1 match score, matched and missing skills and a verdict.',
    prompt: 'Compare the resume with the job description in this text. Reply with JSON only: {"match_score":0.0-1.0,"matched_skills":["..."],"missing_skills":["..."],"verdict":"strong|possible|weak"}',
    validate: o => (!isScore(o?.match_score) ? 'Match score must be a number from 0 to 1' : !isStrArr(o.matched_skills) || !isStrArr(o.missing_skills) ? 'Skill lists are missing' : !oneOf(o.verdict, ['strong', 'possible', 'weak']) ? 'Invalid verdict' : null),
  },
  plain_english: {
    name: 'Plain-English Rewrite', group: 'Work & productivity',
    description: 'Any jargon-heavy text (legal, technical, financial). Returns a plain-English version a 12-year-old could follow, keeping every fact.',
    prompt: 'Rewrite this in plain English that a 12-year-old could follow. Keep every fact and number. Reply with JSON only: {"rewrite":"...","jargon_explained":[{"term":"...","meaning":"..."}]}',
    validate: o => (!str(o?.rewrite, 20) ? 'Rewrite is missing or too short' : !Array.isArray(o.jargon_explained) ? 'jargon_explained must be a list' : null),
  },
  code_explain: {
    name: 'Code Explainer', group: 'Work & productivity',
    description: 'A code snippet. Returns the language, what it does, a step-by-step walk-through and any bugs or risks.',
    prompt: 'Explain this code. Reply with JSON only: {"language":"...","summary":"one sentence","steps":["..."],"risks":["possible bug or security risk"]}',
    validate: o => (!str(o?.language, 1) ? 'Language is missing' : !str(o.summary, 10) ? 'Summary is missing' : !list(o.steps) ? 'Expected at least one step' : null),
  },
});

function parseOutput(raw) {
  try { return parseJson(raw); } catch { return { raw: String(raw).slice(0, 500) }; }
}

module.exports = { SKILLS, parseOutput, EXPENSE_CATEGORIES };

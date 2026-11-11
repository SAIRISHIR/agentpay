// Buyer agents: each has a job, sample inputs and a goal. All sample data is illustrative.

const AGENTS = [
  {
    id: 'atlas', name: 'Atlas', glyph: 'AT', role: 'Research analyst',
    pitch: 'Turns the morning\'s headlines into an investor brief.',
    buys: ['Sentiment', 'Entities', 'Summaries', 'Hindi translation'],
    goal: 'Prepare a morning brief on these headlines for our Mumbai investment desk: the sentiment of each headline, the key companies and people mentioned, and a short Hindi summary of the single most market-moving story.',
    inputLabel: 'headlines',
    docs: [
      'Federal Reserve raises interest rates by 25 basis points for the third consecutive meeting, citing inflation above its 2% target. The S&P 500 fell 1.8% after the announcement.',
      'Tesla reports record quarterly deliveries of 485,000 vehicles, beating analyst estimates by 12%. CEO Elon Musk called the quarter a turning point for EV adoption.',
      'Microsoft Azure suffers a 7-hour global outage that disrupted enterprise customers. Microsoft traced the root cause to a faulty DNS configuration change.',
      'India\'s UPI network processed 14 billion transactions in October, according to NPCI. UPI now accounts for about 80% of retail digital payments in India.',
      'The IMF raised its India growth forecast to 7.8% for fiscal 2024-25, citing strong domestic consumption and public infrastructure spending.',
      'G20 finance ministers meeting in Rio de Janeiro backed a 15% global minimum corporate tax framework signed by 134 countries.',
    ],
  },
  {
    id: 'vera', name: 'Vera', glyph: 'VR', role: 'Accounts payable',
    pitch: 'Reads incoming invoices, books them, and stops fraud before it is paid.',
    buys: ['Invoice extraction', 'Expense categories', 'Fraud checks'],
    goal: 'Process these incoming invoices and receipts: extract the key fields of each, categorize each expense, run a fraud check on each, and produce a payables summary that says what to pay, what to verify and what to block.',
    inputLabel: 'invoices and receipts',
    docs: [
      'INVOICE #INV-20931 from Northwind Cloud Services. Bill to: Halden Supply Co. Items: compute instances (720 hrs) $1,240.00; managed database $380.00; support plan $150.00. Total due: $1,770.00 USD. Due date: 2026-11-15. Pay to the account on file ending 4410.',
      'Receipt: Uber trip, San Francisco airport to downtown, Oct 28, $64.20 USD, paid by corporate card ending 1123. Business purpose: client meeting with Globex.',
      'URGENT INVOICE - Microsft Office Renewal. Your licenses expire TODAY. Wire $4,980.00 USD immediately to our NEW account IBAN GB29 NWBK 6016 1331 9268 19 to avoid service interruption. Reply only to billing@micros0ft-support.com.',
      'Invoice 7781 from Brightline Marketing Ltd for October social media campaign management. One month retainer: EUR 2,500.00. Payment due 30 days from receipt.',
    ],
  },
  {
    id: 'nova', name: 'Nova', glyph: 'NV', role: 'Store launch',
    pitch: 'Writes launch copy and takes new products to new markets.',
    buys: ['Product copy', 'Social posts', 'Spanish and Japanese'],
    goal: 'Launch these three products in our online store: write product copy for each, one launch social post covering all three, and Spanish and Japanese versions of the AeroBrew product description for our new markets.',
    inputLabel: 'product specs',
    docs: [
      'Product: AeroBrew portable espresso maker. 380 g, hand-pumped 16 bar pressure, works with ground coffee and capsules, USB-C heated water tank, 25 shots per charge. Price $129.',
      'Product: TerraPack 28L travel backpack. Recycled ripstop nylon, laptop sleeve for up to 16 inch, hidden passport pocket, carry-on size for most airlines, lifetime warranty. Price $159.',
      'Product: Lumen desk lamp. Adjustable color temperature 2700-6500K, wireless phone charger in the base, auto-dimming light sensor, 12W LED. Price $79.',
    ],
  },
  {
    id: 'echo', name: 'Echo', glyph: 'EC', role: 'Customer support',
    pitch: 'Triages the support inbox while keeping customer data private.',
    buys: ['Personal data redaction', 'Sentiment', 'Replies', 'Action items'],
    goal: 'Triage today\'s customer messages. Redact personal data from each message before using it anywhere else, score each message\'s sentiment, draft a reply to each customer in their own language, and list action items for our team.',
    inputLabel: 'customer messages',
    docs: [
      'Hi, I\'m Priya Sharma (priya.sharma@inbox.test, +91 98765 43210). I was charged twice for order #55120 on Oct 30. Please refund the duplicate $49.99 charge as soon as possible, this is really frustrating.',
      'Love the new app update! The dark mode is gorgeous. Small thing: the export button is hidden on mobile. Thanks, Mark',
      'My package for order #55288 says delivered but I never got it. I live at 221B Baker Street, London NW1 6XE. Call me at 020 7946 0958. I need this resolved before Friday.',
      'Can you add an option to pay with PayPal in installments? I would buy the annual plan today if I could split it. Ana (ana.g@inbox.test)',
      'Hola, compré el plan anual ayer pero no puedo iniciar sesión desde el móvil. Me dice "cuenta no encontrada". ¿Pueden ayudarme hoy? Gracias, Lucía',
    ],
  },
  {
    id: 'iris', name: 'Iris', glyph: 'IR', role: 'Market researcher',
    pitch: 'Researches a new market, checks the facts and briefs the team in their language.',
    buys: ['Research briefs', 'Competitors', 'Fact checks', 'SWOT', 'Portuguese'],
    goal: 'We are deciding whether to launch a pay-later checkout for online merchants in Brazil. Using these notes: get a research brief on the opportunity, a competitor analysis, a fact check of the claims in the notes, and a SWOT. Then get a Portuguese (Brazil) version of your final three-sentence recommendation for the São Paulo team.',
    inputLabel: 'research notes',
    docs: [
      'Question: Should a payments company launch a buy-now-pay-later checkout for small online merchants in Brazil in 2027?',
      'Notes from the team: Pix, Brazil\'s instant payment system run by the central bank, has over 150 million users. Installment payments ("parcelado") on credit cards are already very common in Brazil.',
      'Claims to verify: Brazil is the largest e-commerce market in Latin America. Pix was launched in 2020. Mercado Pago is part of Mercado Libre. Brazil has more than 400 million people.',
      'Known competitors to consider: Mercado Pago, Nubank, PicPay, and card issuers offering interest-free installments.',
    ],
  },
  {
    id: 'mira', name: 'Mira', glyph: 'MR', role: 'Global expansion',
    pitch: 'Takes one product launch to five countries and reads partner mail in any language.',
    buys: ['Localization', 'French, Arabic, German, Korean', 'Language detection', 'Translate to English'],
    goal: 'Take the AeroBrew launch announcement global: a French translation, an Arabic translation for Saudi Arabia, a German version localized for the German market, and a Korean translation. Then detect the language of each partner email and get an English translation of each so the team can answer.',
    inputLabel: 'announcement and partner emails',
    docs: [
      'Announcement: Meet AeroBrew, the 380 g portable espresso maker. 16 bar hand-pumped pressure, a USB-C heated tank and 25 shots per charge. Available from 1 December for $129, with free shipping on orders over $50.',
      'Partner email: Bonjour, nous sommes un distributeur à Lyon. Pouvez-vous nous envoyer vos conditions de gros pour 500 unités AeroBrew avant vendredi ?',
      'Partner email: مرحباً، نحن متجر في الرياض ونرغب في بيع AeroBrew. هل يمكنكم الشحن إلى السعودية وما هي مدة التوصيل؟',
      'Partner email: 안녕하세요, 서울에 있는 카페 체인입니다. AeroBrew 200대를 주문하고 싶은데 한국어 설명서가 있나요?',
    ],
  },
  {
    id: 'rhea', name: 'Rhea', glyph: 'RH', role: 'Fraud & disputes desk',
    pitch: 'Screens scam messages, risky orders and refund requests before money moves.',
    buys: ['Scam detection', 'Chargeback risk', 'Refund triage', 'Moderation'],
    goal: 'Work today\'s fraud and disputes queue: check each forwarded customer message for scams, score each order for chargeback risk, triage each refund request, and moderate the abusive message. Finish with a table-style summary: item, decision, why.',
    inputLabel: 'queue items',
    docs: [
      'Forwarded SMS: "PayPaI Security: your account is limited. Verify now at paypal-secure-login.co to avoid suspension. Reply STOP to cancel."',
      'Order #88231: new account created 6 minutes ago, 4 x high-end gaming laptops ($9,800), billing address in Ohio, shipping to a freight forwarder in Miami, overnight shipping requested.',
      'Order #88240: returning customer since 2021, 1 x desk lamp $79, billing and shipping address match, standard shipping.',
      'Refund request: "I was charged twice for order #55120 on Oct 30 ($49.99 each). Please refund the duplicate." Order history confirms two identical captures one minute apart.',
      'Refund request: "Item arrived but I changed my mind, it\'s been 3 months. Also I want to keep it." Order delivered 94 days ago.',
      'Message to support: "You people are useless idiots. Fix my account or I\'ll make sure everyone knows how pathetic your company is."',
    ],
  },
  {
    id: 'juno', name: 'Juno', glyph: 'JN', role: 'Brand monitor',
    pitch: 'Reads reviews in any language and finds what customers really feel.',
    buys: ['Emotion', 'Aspect sentiment', 'Sarcasm', 'Brand mentions', 'Translate to English', 'Review summary'],
    goal: 'Build this week\'s brand health report for our checkout app: translate the non-English reviews into English, find the emotion and aspect-level sentiment in each review, flag sarcasm, list the brands mentioned, and get an overall review summary.',
    inputLabel: 'app reviews',
    docs: [
      'Review: Checkout is so fast now, paid in two taps. The new one-click PayPal button is brilliant. 5 stars.',
      'Review: Oh great, another update that logs me out every single time. Just what I needed at 2am. Love it.',
      'Avis: Livraison rapide mais le service client ne répond jamais. Le remboursement a pris trois semaines.',
      'Reseña: La app es buena pero las comisiones son más altas que con Mercado Pago. Me cambiaré si no bajan.',
      'Review: Switched from Stripe Link for our store and conversion went up. Shopify integration took ten minutes.',
    ],
  },
];

const byId = id => AGENTS.find(a => a.id === id) || AGENTS[0];

module.exports = { AGENTS, byId };

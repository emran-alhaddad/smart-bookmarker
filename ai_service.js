(() => {
'use strict';

// Extended classification logic and helpers
// Domain to category mapping for high-confidence classification
const DOMAIN_CATEGORY_MAP = {
  'cloudflare.com': 'devops',
  'dash.cloudflare.com': 'devops',
  'aws.amazon.com': 'cloud',
  'console.aws.amazon.com': 'cloud',
  'amazonaws.com': 'cloud',
  'oraclecloud.com': 'cloud',
  'octopus.do': 'uxui',
  'figma.com': 'uxui',
  'ahrefs.com': 'seo',
  'gtmetrix.com': 'qa',
  'pagespeed.web.dev': 'qa',
  'campaignmonitor.com': 'docs',
  'docs.google.com': 'docs',
  'google.com': 'docs',
  'youtube.com': 'media',
  'ssyoutube.com': 'media',
  'codepen.io': 'frontend',
  'cssgradient.io': 'frontend',
  'vercel.com': 'frontend',
  'github.com': 'programming',
  'gitlab.com': 'programming',
  'stackoverflow.com': 'programming',
  'mailtrap.io': 'devops',
  'grafana.com': 'devops',
  'screamingfrog.co.uk': 'seo',
  'totalworkplace.sharepoint.com': 'docs',
  'office.com': 'docs'
  ,
  // Treat generic SharePoint and OneDrive domains as documentation/collaboration
  'sharepoint.com': 'docs',
  'onedrive.live.com': 'docs',
  // Common code commit endpoints map to cloud (AWS CodeCommit) or version control
  'git-codecommit.amazonaws.com': 'cloud',
  'codecommit.amazonaws.com': 'cloud'
};

// Map fine-grained categories to high-level categories with optional sub-slugs.  The
// returned slug may include a parent and child separated by a slash.  For example,
// 'devops' -> 'developer/devops', 'online-tools' -> 'tools/free-tools', 'cms' -> 'workspaces/cms'.
const GENERAL_CATEGORY_MAP = {
  // Map fine categories into broad, user-friendly groups.  The top-level
  // groups include developer (for tech), tools, workspaces, docs, media,
  // social, shopping, learning and other.  Subcategories are encoded
  // after a slash (e.g. 'tools/ai-tools').  These mappings ensure we
  // don’t end up with dozens of micro categories.
  devops: 'developer/devops',
  cloud: 'developer/cloud',
  frontend: 'developer/frontend',
  backend: 'developer/backend',
  cms: 'workspaces/cms',
  programming: 'developer/programming',
  'online-tools': 'tools/free-tools',
  uxui: 'tools/design-tools',
  seo: 'tools/seo-tools',
  qa: 'developer/qa',
  media: 'media',
  docs: 'docs',
  ecommerce: 'shopping',
  education: 'learning',
  other: 'other',
  // Map login pages explicitly into workspaces
  'workspaces/login-pages': 'workspaces/login-pages'
};

function mapToGeneral(cat) {
  return GENERAL_CATEGORY_MAP[cat] || cat;
}

// Path-based hints for classification
const PATH_HINTS = [
  { rx: /\/cp\/dashboard|\/wp-admin|cpsess|:2083|\/admin/i, cat: 'cms' },
  // Login/signin pages: classify explicitly as a workspace login page
  { rx: /\/login|signin|sign-in|auth/i,            cat: 'workspaces/login-pages' },
  { rx: /\/(design|proto|node-id|canvas|drawio)/i, cat: 'uxui' },
  { rx: /\/(seo|sitemap|lighthouse|analysis)/i,    cat: 'seo' },
  { rx: /\/(speed|load|perf|gtmetrix)/i,           cat: 'qa' },
  { rx: /\/(convert|resize|encode|decode)/i,       cat: 'online-tools' },
  { rx: /\/(media|video|download|mp4)/i,           cat: 'media' },
  { rx: /\/(docs|document|sheet|slides)/i,         cat: 'docs' },
  { rx: /\/(faq|guide|tutorial|help|knowledge)/i,   cat: 'docs' },
  { rx: /\/(graphql|api|rest)/i,                   cat: 'programming' },
  // eCommerce patterns: products, store, shop, checkout, cart
  { rx: /\/(shop|store|cart|product|products|checkout|ecommerce)/i, cat: 'ecommerce' },
  // Education patterns: course, college, university, school, learning
  { rx: /\/(course|courses|college|university|school|training|learn|education)/i, cat: 'education' }
];

// Keyword scores for fallback classification
const KEYWORDS = {
  devops: ['cloudflare','grafana','mailtrap','cicd','pipeline','monitoring','kubernetes','helm','prometheus','ansible','nginx','ingress','dns','waf','ssl','tls','cert'],
  cloud: ['aws','s3','ec2','rds','route 53','oci','oracle cloud','gcp','azure','iam','vpc','compute'],
  frontend: ['react','next','vue','angular','css','tailwind','sass','vite','webpack','storybook','component','ui','codepen','gradient','cssgradient','vercel'],
  uxui: ['figma','wireframe','prototype','ux','ui','design system','octopus','draw.io','diagrams','octopus.do','node-id'],
  seo: ['ahrefs','semrush','sitemap','backlink','schema','gsc','gigalist','seo'],
  qa: ['gtmetrix','lighthouse','browserstack','lambda test','pentest','performance','testing','qa','qa tools'],
  docs: ['docs','document','slides','sheet','confluence','wiki','guide','checklist','documentation'],
  media: ['video','mp4','youtube','downloader','suno','pixlr','shots','mockup','media','image','png','jpg'],
  cms: ['cpanel','wp-admin','statamic','drupal','content','cms','collection','entries','admin','cp/dashboard'],
  programming: ['github','gitlab','code','repo','er diagram','drawio','query','api','swagger','graphql','postman','json','csv'],
  'online-tools': ['converter','encode','decode','resize','favicon','uuid','formatter','dns','whatsmydns','tool','online'],
  // Ecommerce keywords
  ecommerce: ['shop','store','cart','checkout','ecommerce','shopping','product','seller','buyer','order','price','customer'],
  // Education keywords
  education: ['education','college','university','school','course','courses','learning','training','academy','class','students']
};

// Fetch a webpage HTML safely with a timeout.  Returns up to `bytes` characters.
async function fetchPageContent(url, timeoutMs = 3500, bytes = 150000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(t);
    return (await res.text()).slice(0, bytes);
  } catch {
    return '';
  }
}

// Extract the page <title> tag from HTML
function extractTitle(html) {
  const m = /<title[^>]*>([^<]*)/i.exec(html);
  return m ? m[1].trim() : '';
}

// Extract the meta description or og:description from HTML
function extractMetaDesc(html) {
  const m1 = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i.exec(html);
  if (m1) return m1[1].trim();
  const m2 = /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i.exec(html);
  if (m2) return m2[1].trim();
  return '';
}

// Build a bag of text from HTML: title, meta descriptions and headings
function textBagFromHtml(html) {
  const title = extractTitle(html);
  const metas = [];
  // Collect meta contents
  const metaRegex = /<meta[^>]+content=["']([^"']+)["']/gi;
  let m;
  while ((m = metaRegex.exec(html)) !== null) {
    metas.push(m[1]);
  }
  // Collect heading text (h1-h3)
  const headings = [];
  const hRegex = /<(h1|h2|h3)[^>]*>([^<]+)/gi;
  let h;
  while ((h = hRegex.exec(html)) !== null) {
    headings.push(h[2]);
  }
  return [title, metas.join(' '), headings.join(' ')].join(' ').toLowerCase();
}

// Compute keyword scores
function scoreKeywords(bag) {
  const scores = {};
  for (const [cat, words] of Object.entries(KEYWORDS)) {
    let s = 0;
    for (const w of words) {
      if (bag.includes(w)) s++;
    }
    scores[cat] = s;
  }
  return scores;
}

// AI Service abstraction providing flexible classification strategies.
//
// This module selects between local classification and various API providers
// based on user settings.  Supported modes include:
//   - local: heuristic TF‑IDF & keyword matching built into the extension.
//   - api_auto: try OpenAI → Gemini → Claude → uClassify in order.
//   - api_openai: use OpenAI only.
//   - api_gemini: use Google Gemini only.
//   - api_claude: use Anthropic Claude only.
//   - api_uclassify: use uClassify only.
//
// Each provider is stubbed to fall back to local classification in this
// environment where external calls are blocked.  If valid API keys are
// present and external fetches are permitted, the provider functions can
// be extended to perform real requests.

class LocalClassifier {
  constructor(customCategories = []) {
    this.customCategories = customCategories;
  }
  // Simple keyword heuristics to assign a high‑level category.
  categorize(text) {
    const s = (text || '').toLowerCase();
    const hit = (arr) => arr.some((k) => s.includes(k));
    if (hit(['ai','artificial intelligence','machine learning','neural','chatgpt','openai','hugging face','tensorflow','pytorch','claude','gemini','anthropic','llm'])) return 'AI Tools';
    if (hit(['react','vue','angular','svelte','typescript','javascript','css','html','frontend','ui','ux','design','tailwind','bootstrap','sass','vite','webpack'])) return 'Frontend';
    if (hit(['backend','server','api','rest','graphql','node','express','django','flask','fastapi','spring','laravel','php','python','java','golang','rust','microservice','serverless'])) return 'Backend';
    if (hit(['database','sql','mysql','postgresql','postgres','mongodb','redis','elasticsearch','cassandra','oracle','sqlite'])) return 'Database';
    if (hit(['test','testing','qa','quality assurance','selenium','cypress','jest','mocha','junit','pytest','e2e','tdd','bdd'])) return 'QA';
    if (hit(['docker','kubernetes','k8s','aws','azure','gcp','devops','jenkins','gitlab','github actions','terraform','ansible','helm','prometheus','grafana','infrastructure'])) return 'DevOps';
    if (hit(['docs','documentation','guide','tutorial','manual','reference']) || s.includes('docs.') || s.includes('/docs/')) return 'Documentation';
    if (hit(['github','stackoverflow','programming','code','developer','coding','software'])) return 'Programming';
    // Custom categories: if a custom label appears in text, pick it
    for (const c of this.customCategories) {
      const lc = String(c).trim().toLowerCase();
      if (lc && s.includes(lc)) return c;
    }
    return 'Other';
  }
}

class AIService {
  constructor() {
    // Classification mode: local, api_auto, api_openai, api_gemini, api_claude, api_uclassify
    this.mode = 'local';
    // API keys
    this.openaiApiKey = null;
    this.geminiApiKey = null;
    this.claudeApiKey = null;
    this.uclassifyApiKey = null;
    // Delay between requests to avoid hitting rate limits
    this.rateLimitDelay = 2000;
    this.lastRequest = 0;
    // Custom categories defined by user
    this.customCategories = [];
    // Local classifier instance
    this.localClassifier = new LocalClassifier();
  }

  async init() {
    const data = await chrome.storage.local.get([
      'classification_mode',
      'openai_api_key',
      'gemini_api_key',
      'claude_api_key',
      'uclassify_api_key',
      'rate_limit_delay',
      'custom_categories'
    ]);
    this.mode = data.classification_mode || 'local';
    this.openaiApiKey = data.openai_api_key || null;
    this.geminiApiKey = data.gemini_api_key || null;
    this.claudeApiKey = data.claude_api_key || null;
    this.uclassifyApiKey = data.uclassify_api_key || null;
    this.rateLimitDelay = Number.isFinite(data.rate_limit_delay) ? data.rate_limit_delay : 2000;
    this.customCategories = Array.isArray(data.custom_categories) ? data.custom_categories.filter(Boolean) : [];
    this.localClassifier = new LocalClassifier(this.customCategories);
  }

  async waitRateLimit() {
    const now = Date.now();
    const delta = now - this.lastRequest;
    if (delta < this.rateLimitDelay) {
      await new Promise((resolve) => setTimeout(resolve, this.rateLimitDelay - delta));
    }
    this.lastRequest = Date.now();
  }

  // Provider: OpenAI (stubbed to local)
  async categorizeWithOpenAI(text) {
    // If no key or not selected, skip
    if (!this.openaiApiKey) return null;
    try {
      await this.waitRateLimit();
      // In a real implementation, call OpenAI Chat Completion API here
      // For this environment we return null to force fallback
      return null;
    } catch {
      return null;
    }
  }

  // Provider: Gemini (stubbed)
  async categorizeWithGemini(text) {
    if (!this.geminiApiKey) return null;
    try {
      await this.waitRateLimit();
      return null;
    } catch {
      return null;
    }
  }

  // Provider: Claude (stubbed)
  async categorizeWithClaude(text) {
    if (!this.claudeApiKey) return null;
    try {
      await this.waitRateLimit();
      return null;
    } catch {
      return null;
    }
  }

  // Provider: uClassify (stubbed to local)
  async categorizeWithUClassify(text) {
    if (!this.uclassifyApiKey) return null;
    try {
      await this.waitRateLimit();
      return null;
    } catch {
      return null;
    }
  }

  async categorizeText(text) {
    // Ensure we have loaded settings
    if (!this.localClassifier) await this.init();
    const mode = this.mode || 'local';
    // Determine provider order based on mode
    if (mode === 'local') {
      return this.localClassifier.categorize(text);
    }
    if (mode === 'api_openai') {
      const openai = await this.categorizeWithOpenAI(text);
      return openai || this.localClassifier.categorize(text);
    }
    if (mode === 'api_gemini') {
      const gem = await this.categorizeWithGemini(text);
      return gem || this.localClassifier.categorize(text);
    }
    if (mode === 'api_claude') {
      const cla = await this.categorizeWithClaude(text);
      return cla || this.localClassifier.categorize(text);
    }
    if (mode === 'api_uclassify') {
      const uc = await this.categorizeWithUClassify(text);
      return uc || this.localClassifier.categorize(text);
    }
    // api_auto or unknown: cascade through providers
    const providers = [
      () => this.categorizeWithOpenAI(text),
      () => this.categorizeWithGemini(text),
      () => this.categorizeWithClaude(text),
      () => this.categorizeWithUClassify(text)
    ];
    for (const fn of providers) {
      const result = await fn();
      if (result) return result;
    }
    return this.localClassifier.categorize(text);
  }

  async categorizeBookmark({ title, url, summary }) {
    // Legacy wrapper: return only the primary category slug determined by
    // the detailed classifier.  The optional summary parameter is ignored.
    const { category } = await this.categorizeBookmarkDetailed({ title, url });
    return category;
  }

  /**
   * Perform a detailed classification on a bookmark.
   *
   * This method returns an object with a list of candidate categories and
   * the chosen primary category.  It consults stored manual overrides,
   * deterministic domain/path mappings, keyword heuristics and optional
   * external API providers.  Categories are returned by their slug id
   * defined in the userCategories structure (e.g. 'devops', 'frontend').
   *
   * @param {Object} obj - bookmark info
   * @param {string} obj.id - bookmark id (optional; used for manual lookup)
   * @param {string} obj.title - bookmark title
   * @param {string} obj.url - bookmark URL
   * @returns {Promise<{categories: string[], primary: string, source: string}>}
   */
  async categorizeBookmarkDetailed({ id, title, url }) {
    // Load user settings, categories and bookmark metadata
    await this.init();
    const storage = await chrome.storage.local.get(['userCategories', 'bookmarkMeta', 'openai_api_key']);
    const userCategories = storage.userCategories || {};
    const meta = storage.bookmarkMeta || {};
    const openaiKey = storage.openai_api_key || null;
    // 1) Manual override: if user manually set a category/description, honor it
    if (id && meta[id] && meta[id].manual && meta[id].primary) {
      const manualCat = meta[id].primary;
      const desc = meta[id].description || '';
      return { category: manualCat, description: desc, source: 'manual' };
    }
    // Prepare host and pathname
    let host = '';
    let pathname = '';
    try {
      const u = new URL(url || '');
      host = u.hostname.toLowerCase().replace(/^www\./, '');
      pathname = (u.pathname + u.search).toLowerCase();
    } catch {
      host = '';
      pathname = '';
    }
    // Fetch HTML content for deeper analysis
    const html = await fetchPageContent(url || '');
    const extractedTitle = extractTitle(html) || title || host;
    const metaDesc = extractMetaDesc(html);
    // Build a broader text bag from the HTML: includes title, meta descriptions,
    // headings and other prominent text.  This bag is used both for keyword
    // scoring and for generating a fallback summary.
    const bagText = textBagFromHtml(html);
    // Generate a short summary (1-2 sentences) from the bag.  If no meta
    // description exists, fall back to the first couple of sentences from
    // the page content.  Limit summary length to 240 characters.
    const summarySentences = bagText.split(/\.\s+/);
    const summary = summarySentences.slice(0, 2).join('. ').trim().slice(0, 240);
    // Domain mapping: choose category if host matches.  If user categories
    // contain the slug, pick it; otherwise still return the mapping.  Also
    // include description fallback here.
    if (DOMAIN_CATEGORY_MAP[host]) {
      // Map to a high-level category to avoid too many fine-grained buckets
      const domainCat = mapToGeneral(DOMAIN_CATEGORY_MAP[host]);
      const descOut = metaDesc || summary;
      return { category: domainCat, description: descOut, source: 'domain' };
    }
    // Path hints: check for hint patterns; these hint categories even if domain unknown
    for (const hint of PATH_HINTS) {
      if (hint.rx.test(pathname)) {
        const descOut = metaDesc || summary;
        // Generalize path-based category
        const hintCat = mapToGeneral(hint.cat);
        return { category: hintCat, description: descOut, source: 'path' };
      }
    }
    // AI classification via OpenAI: if key present and categories defined
    if (openaiKey) {
      try {
        const labelSet = Object.keys(userCategories);
        // Provide candidates; may be empty (model may propose new slug)
        const contentSample = textBagFromHtml(html).slice(0, 20000);
        const sys = 'Respond with strict JSON. Pick ONE best-fit category slug from the provided list; if none fit or list empty, propose a new slugified category. Provide a 1-2 sentence description written from page content.';
        const userMsg = JSON.stringify({ url, host, title: extractedTitle, candidates: labelSet, contentSample });
        const payload = {
          model: 'gpt-4o-mini',
          temperature: 0,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: userMsg }
          ]
        };
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + openaiKey
          },
          body: JSON.stringify(payload)
        });
        const data = await resp.json();
        const txt = data.choices?.[0]?.message?.content?.trim() || '{}';
        let parsed;
        try {
          parsed = JSON.parse(txt);
        } catch {
          parsed = {};
        }
        let chosen = (parsed.category || '').trim();
        let description = (parsed.description || metaDesc || '').trim();
        if (!chosen) chosen = 'other';
        // Map to general category when appropriate
        const mapped = mapToGeneral(chosen);
        return { category: mapped, description, source: 'openai' };
      } catch (e) {
        // Fail gracefully to heuristics
      }
    }
    // Local heuristics: apply keyword scoring on the larger bag text.  This
    // includes title, headings and other textual content extracted from the
    // page.  It increases the chance of finding relevant keywords.
    const bag = bagText;
    const scores = scoreKeywords(bag);
    let bestCat = '';
    let bestScore = 0;
    Object.entries(scores).forEach(([cat, score]) => {
      if (score > bestScore) {
        bestScore = score;
        bestCat = cat;
      }
    });
    if (bestScore > 0) {
      const descOut = metaDesc || summary;
      const mapped = mapToGeneral(bestCat);
      return { category: mapped, description: descOut, source: 'local' };
    }
    // Fallback: assign to 'other' and include description fallback, using general map
    const fallbackCat = mapToGeneral('other');
    return { category: fallbackCat, description: metaDesc || summary, source: 'default' };
  }
}

// Expose class for background importScripts
if (typeof self !== 'undefined') {
  self.AIService = AIService;
}

})();
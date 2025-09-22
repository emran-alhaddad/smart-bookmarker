// Background service worker for Smart Bookmark Organizer (v2)
//
// This service orchestrates bookmark management, classification and UI
// coordination.  It supports asynchronous organization with progress
// tracking, customizable classification modes, and provides data for
// the dashboard and popup.  All bookmarks are stored under a parent
// folder labelled 🧠 Smart Bookmarks for quick access via the native
// Chrome bookmark manager.

// Load AI service with defensive import to avoid crashing the service worker
try {
  importScripts('ai_service.js');
} catch (e) {
  console.error('AI service load failed', e);
}

const aiService = new AIService();
const SMART_PARENT = '🧠 Smart Bookmarks';

// Default categories removed. Categories will be created dynamically when
// bookmarks are classified or manually added by the user.  No categories
// are created on install or startup.

// Persistent stats and progress state
let organizationStats = {
  totalBookmarks: 0,
  categoriesCreated: 0,
  categories: {},
  favorites: 0,
  recent: 0
};
let orgState = {
  status: 'idle',      // idle | running | done
  total: 0,
  done: 0,
  startedAt: null,
  lastTitle: null,
  provider: 'local'
};

// Broadcast progress to popup and dashboard.  Stores the current
// progress state in chrome.storage.local (under organize_progress) and
// sends a runtime message.  Both popup and dashboard listen for
// organizeProgress messages and update their UI accordingly.  This
// helper allows both pages to share the same loader and progress bar.
function broadcastProgress(state) {
  // Persist progress so that popup reopens with current state
  chrome.storage.local.set({ organize_progress: state }, () => {
    // Fire-and-forget runtime message
    try {
      chrome.runtime.sendMessage({ action: 'organizeProgress', state });
    } catch (e) {
      // Ignore if no listeners are active (e.g., popup not open)
    }
  });
}

// Load stats/state from storage
async function loadState() {
  const data = await chrome.storage.local.get(['organization_stats', 'org_state']);
  if (data.organization_stats) organizationStats = data.organization_stats;
  if (data.org_state) orgState = { ...orgState, ...data.org_state };
}

async function saveStats() {
  await chrome.storage.local.set({ organization_stats: organizationStats });
}

async function saveOrgState() {
  await chrome.storage.local.set({ org_state: orgState });
}

// Helpers to find or create the smart parent folder
async function getSmartParentId() {
  return new Promise((resolve) => {
    chrome.bookmarks.search({ title: SMART_PARENT }, (results) => {
      const folder = results.find((r) => !r.url && r.title === SMART_PARENT);
      if (folder) return resolve(folder.id);
      chrome.bookmarks.create({ title: SMART_PARENT }, (f) => resolve(f.id));
    });
  });
}

async function getOrCreateChildFolder(parentId, name) {
  return new Promise((resolve) => {
    chrome.bookmarks.getChildren(parentId, (children) => {
      const existing = (children || []).find((c) => !c.url && c.title === name);
      if (existing) return resolve(existing.id);
      chrome.bookmarks.create({ parentId, title: name }, (f) => resolve(f.id));
    });
  });
}

async function getAllBookmarksFlat() {
  return new Promise((resolve) => {
    chrome.bookmarks.getTree((tree) => {
      const acc = [];
      const walk = (node, path = []) => {
        if (node.url && /^https?:/i.test(node.url)) {
          acc.push({ id: node.id, title: node.title, url: node.url, parentId: node.parentId, dateAdded: node.dateAdded, path });
        }
        (node.children || []).forEach((c) => walk(c, node.title ? path.concat(node.title) : path));
      };
      (tree || []).forEach((t) => walk(t));
      resolve(acc);
    });
  });
}

// Fetch and summarise a page for better classification and dashboard display
async function fetchSummary(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { method: 'GET', mode: 'cors', signal: controller.signal, credentials: 'omit' });
    clearTimeout(timer);
    const ct = String(res.headers.get('content-type') || '');
    if (!ct.includes('text/html')) return '';
    const html = await res.text();
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] || '';
    const desc = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i.exec(html)?.[1]
              || /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i.exec(html)?.[1]
              || '';
    let summary = desc;
    if (!summary) {
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ');
      summary = text.split(/\.\s+/).slice(0, 2).join('. ').trim().slice(0, 240);
    }
    return `${title} ${summary}`.trim();
  } catch {
    return '';
  }
}


async function ensureCategoryFolder(categoryId) {
  // Create or return the bookmark folder corresponding to the given category slug.
  // The folder title is composed of the emoji and display name from userCategories.
  const data = await chrome.storage.local.get(['userCategories']);
  const userCategories = data.userCategories || {};
  // Use user-defined category if present, otherwise derive a human-friendly name
  let cat = userCategories[categoryId];
  if (!cat) {
    // Derive a simple name from slug (capitalize words)
    const friendly = String(categoryId)
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    cat = { id: categoryId, name: friendly, emoji: '' };
  }
  const folderName = `${cat.emoji ? cat.emoji + ' ' : ''}${cat.name}`;
  const parentId = await getSmartParentId();
  return await getOrCreateChildFolder(parentId, folderName);
}

// Ensure a set of default categories exist under the smart parent folder
async function ensureDefaultCategories() {
  // Backwards compatibility: simply ensure user-defined category folders exist
  return await ensureUserCategoryFolders();
}

async function safeMove(bookmarkId, parentId) {
  try {
    await chrome.bookmarks.move(bookmarkId, { parentId });
  } catch (e) {
    console.warn('Move failed', e);
  }
}

// Ensure that the user's category folders exist under the smart parent folder.
// This creates folders based on the userCategories stored in chrome.storage.local.
// If no user-defined categories exist yet, it initializes them with the
// DEFAULT_USER_CATEGORIES.  Folders are named with the emoji and the
// human-readable name (e.g. '🧪 UX/UI').
async function ensureUserCategoryFolders() {
  // Ensure bookmark folders exist for all current user categories.
  // Do not initialize with defaults when no categories exist.  Folders
  // will be created dynamically when categories are created or used.
  const data = await chrome.storage.local.get(['userCategories']);
  const userCategories = data.userCategories || {};
  // If there are no categories defined, do nothing
  if (!userCategories || Object.keys(userCategories).length === 0) return;
  const parentId = await getSmartParentId();
  const children = await new Promise((resolve) => {
    chrome.bookmarks.getChildren(parentId, (c) => resolve(c || []));
  });
  const existing = {};
  children.forEach((child) => {
    if (!child.url) existing[child.title] = child.id;
  });
  // Create missing folders for user-defined categories
  for (const cat of Object.values(userCategories)) {
    const folderName = `${cat.emoji ? cat.emoji + ' ' : ''}${cat.name}`;
    if (!existing[folderName]) {
      await new Promise((resolve) => {
        chrome.bookmarks.create({ parentId, title: folderName }, () => resolve());
      });
    }
  }
}

// Resolve a bookmark to a detailed classification using the AI service.
// Returns an object with "categories" (array of slugs) and "primary" (slug).
async function categorizeBookmarkDetailed(bm) {
  return await aiService.categorizeBookmarkDetailed({ id: bm.id, title: bm.title, url: bm.url });
}

// Start asynchronous organization.  Returns immediately and updates orgState.
async function startOrganize() {
  // Load classification settings
  await aiService.init();
  // Compute list of bookmarks to process (HTTP(S) only, not in smart parent)
  const list = await getAllBookmarksFlat();
  const smartParentId = await getSmartParentId();
  const toProcess = list.filter((b) => b.parentId !== smartParentId);
  // Determine organize strategy (clone or move). Default to clone if not set.
  const stratData = await chrome.storage.local.get(['organize_strategy']);
  const strategy = stratData.organize_strategy || 'clone';

  orgState = {
    status: 'running',
    total: toProcess.length,
    done: 0,
    startedAt: Date.now(),
    lastTitle: null,
    provider: aiService.mode || 'local'
  };
  await saveOrgState();
  // Immediately broadcast initial progress so UI shows loader
  broadcastProgress({ status: 'running', done: 0, total: toProcess.length });
  // Reset stats
  organizationStats.totalBookmarks = list.length;
  organizationStats.categories = {};
  organizationStats.recent = 0;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  // Load existing bookmark metadata and user categories
  const metaStore = await chrome.storage.local.get(['bookmarkMeta', 'userCategories']);
  let meta = metaStore.bookmarkMeta || {};
  let userCategories = metaStore.userCategories || {};
  // Process sequentially
  for (const bm of toProcess) {
    if (orgState.status !== 'running') break;
    try {
      // Use the AI service to classify this bookmark (single category + description)
      const { category: cat, description } = await aiService.categorizeBookmarkDetailed({ id: bm.id, title: bm.title, url: bm.url });
      const slug = cat || 'other';
      // Add new user category if slug not present
      if (!userCategories[slug]) {
        const friendly = slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        userCategories[slug] = { id: slug, name: friendly, emoji: '📁', parent: null, order: Object.keys(userCategories).length + 1 };
      }
      // Persist classification for this original bookmark to avoid reprocessing
      meta[bm.id] = meta[bm.id] || {};
      meta[bm.id].primary = slug;
      meta[bm.id].description = description || '';
      meta[bm.id].manual = !!meta[bm.id].manual;
      // Ensure folder exists
      const targetParent = await ensureCategoryFolder(slug);
      if (strategy === 'move') {
        // Move original bookmark into the category folder
        await safeMove(bm.id, targetParent);
      } else {
        // Clone: create a new bookmark in the category folder without moving original
        await new Promise((resolve) => {
          chrome.bookmarks.create({ parentId: targetParent, title: bm.title, url: bm.url }, (newBm) => {
            // Persist meta for the clone
            meta[newBm.id] = meta[newBm.id] || {};
            meta[newBm.id].primary = slug;
            meta[newBm.id].description = description || '';
            meta[newBm.id].manual = !!meta[newBm.id].manual;
            resolve();
          });
        });
      }
      // Update stats
      organizationStats.categories[slug] = (organizationStats.categories[slug] || 0) + 1;
      if (bm.dateAdded && bm.dateAdded > weekAgo) organizationStats.recent += 1;
      orgState.done += 1;
      orgState.lastTitle = bm.title;
      await saveOrgState();
      // Broadcast progress after each bookmark is processed
      broadcastProgress({ status: 'running', done: orgState.done, total: orgState.total });
    } catch (e) {
      console.error('Error organizing', bm.url, e);
    }
  }
  // Save updated metadata and user categories
  await chrome.storage.local.set({ bookmarkMeta: meta, userCategories });
  orgState.status = 'done';
  await saveOrgState();
  // Broadcast final progress state
  broadcastProgress({ status: 'done', done: orgState.total, total: orgState.total });
  organizationStats.categoriesCreated = Object.keys(organizationStats.categories).length;
  await saveStats();
  return { success: true };
}

// Quick add the current page
// Accepts optional override params: category (existing slug) and newCategory {id,name,emoji,parent}
async function addCurrentPage(url, title, override = {}) {
  await aiService.init();
  // Determine desired category: explicit override category or newCategory or auto classify
  let slug;
  let description = '';
  const { category: overrideCat, newCategory } = override || {};
  // Load existing categories and meta
  const store = await chrome.storage.local.get(['userCategories', 'bookmarkMeta']);
  let userCategories = store.userCategories || {};
  let meta = store.bookmarkMeta || {};
  if (overrideCat) {
    slug = overrideCat;
    // Ensure slug exists
    if (!userCategories[slug]) {
      // Derive friendly name from slug
      const friendly = slug.split(/[-\/]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      userCategories[slug] = { id: slug, name: friendly, emoji: '📁', parent: null, order: Object.keys(userCategories).length + 1 };
    }
  } else if (newCategory && newCategory.id) {
    // Add the new category to userCategories
    const nc = newCategory;
    userCategories[nc.id] = {
      id: nc.id,
      name: nc.name || nc.id,
      emoji: nc.emoji || '📁',
      parent: nc.parent || null,
      order: Object.keys(userCategories).length + 1
    };
    slug = nc.id;
  } else {
    // Auto classify
    const detail = await aiService.categorizeBookmarkDetailed({ title, url });
    slug = detail.category || 'other';
    description = detail.description || '';
  }
  // If description still empty (override or newCategory), fetch description via AI
  if (!description) {
    try {
      const det = await aiService.categorizeBookmarkDetailed({ title, url });
      description = det.description || '';
    } catch {
      description = '';
    }
  }
  // Ensure category exists in userCategories
  if (!userCategories[slug]) {
    const friendly = slug.split(/[-\/]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    userCategories[slug] = { id: slug, name: friendly, emoji: '📁', parent: null, order: Object.keys(userCategories).length + 1 };
  }
  // Ensure category folder exists
  const parentId = await ensureCategoryFolder(slug);
  // Create the bookmark in the correct folder
  const bm = await chrome.bookmarks.create({ parentId, title, url });
  // Persist meta
  meta[bm.id] = meta[bm.id] || {};
  meta[bm.id].primary = slug;
  meta[bm.id].description = description || '';
  meta[bm.id].manual = !!meta[bm.id].manual;
  await chrome.storage.local.set({ userCategories, bookmarkMeta: meta });
  // Update stats
  organizationStats.categories[slug] = (organizationStats.categories[slug] || 0) + 1;
  organizationStats.totalBookmarks += 1;
  organizationStats.recent += 1;
  organizationStats.categoriesCreated = Object.keys(organizationStats.categories).length;
  await saveStats();
  return { success: true, category: slug };
}

// Build dashboard data: group bookmarks by category with tags and summaries
async function getDashboardData() {
  // Initialize AI service when needed for uncategorized bookmarks
  await aiService.init();
  const list = await getAllBookmarksFlat();
  const result = {};
  // Load user categories and metadata
  const store = await chrome.storage.local.get(['userCategories', 'bookmarkMeta']);
  let userCategories = store.userCategories || {};
  let meta = store.bookmarkMeta || {};
  let metaDirty = false;
  // Build mapping of folder IDs to slugs for existing category folders
  const smartId = await getSmartParentId();
  const catChildren = await new Promise((resolve) => {
    chrome.bookmarks.getChildren(smartId, (children) => resolve(children || []));
  });
  const folderIdToSlug = {};
  catChildren.forEach((child) => {
    if (!child.url) {
      // Reverse lookup: match folder title to a slug by comparing to user categories
      for (const slug of Object.keys(userCategories)) {
        const cat = userCategories[slug];
        const title = `${cat.emoji ? cat.emoji + ' ' : ''}${cat.name}`;
        if (child.title === title) {
          folderIdToSlug[child.id] = slug;
          break;
        }
      }
    }
  });
  for (const bm of list) {
    let slug;
    let description = '';
    // Determine category by folder if inside smart parent
    if (folderIdToSlug[bm.parentId]) {
      slug = folderIdToSlug[bm.parentId];
    } else if (meta[bm.id] && meta[bm.id].primary) {
      slug = meta[bm.id].primary;
      description = meta[bm.id].description || '';
    } else {
      // Classify and persist
      try {
        const detail = await aiService.categorizeBookmarkDetailed({ id: bm.id, title: bm.title, url: bm.url });
        slug = detail.category || 'other';
        description = detail.description || '';
        // Add new category if needed
        if (!userCategories[slug]) {
          const friendly = slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
          userCategories[slug] = { id: slug, name: friendly, emoji: '📁', parent: null, order: Object.keys(userCategories).length + 1 };
        }
        meta[bm.id] = meta[bm.id] || {};
        meta[bm.id].primary = slug;
        meta[bm.id].description = description;
        meta[bm.id].manual = !!meta[bm.id].manual;
        metaDirty = true;
        // Move bookmark to appropriate folder
        const parentId = await ensureCategoryFolder(slug);
        await safeMove(bm.id, parentId);
      } catch {
        slug = 'other';
      }
    }
    const cat = userCategories[slug] || { name: slug, emoji: '' };
    const displayName = `${cat.emoji ? cat.emoji + ' ' : ''}${cat.name}`;
    if (!result[displayName]) result[displayName] = { count: 0, items: [] };
    result[displayName].count += 1;
    // Generate simple tags based on domain and keywords
    const tags = [];
    const urlLower = (bm.url || '').toLowerCase();
    const titleLower = (bm.title || '').toLowerCase();
    if (urlLower.includes('github')) tags.push('github');
    if (urlLower.includes('stackoverflow')) tags.push('stackoverflow');
    if (urlLower.includes('docs') || titleLower.includes('docs')) tags.push('docs');
    if (urlLower.includes('api') || titleLower.includes('api')) tags.push('api');
    if (titleLower.includes('tutorial')) tags.push('tutorial');
    if (titleLower.includes('guide')) tags.push('guide');
    result[displayName].items.push({
      id: bm.id,
      title: bm.title,
      url: bm.url,
      description: description,
      tags: tags.slice(0, 3),
      primary: slug
    });
  }
  if (metaDirty) {
    await chrome.storage.local.set({ bookmarkMeta: meta, userCategories });
  }
  return result;
}

// Event listeners
chrome.runtime.onInstalled.addListener(async () => {
  // Load persisted state
  await loadState();
  // Create context menus
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'ai_bookmark', title: 'AI Bookmark this page', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'ai_organize', title: 'Organize All Bookmarks', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'open_dashboard', title: 'Open Dashboard', contexts: ['action'] });
  });
  // No categories are created on install. Category folders will be created dynamically when needed.
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'ai_bookmark' && tab) {
    await addCurrentPage(tab.url, tab.title);
  } else if (info.menuItemId === 'ai_organize') {
    startOrganize();
  } else if (info.menuItemId === 'open_dashboard') {
    // open dashboard.html in new tab
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'quick_add') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await addCurrentPage(tab.url, tab.title);
  }
});

// Message API for popup/options/dashboard
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action === 'startOrganize') {
    startOrganize().then(() => sendResponse({ success: true }));
    return true;
  }
  if (req.action === 'getProgress') {
    sendResponse({ ...orgState });
  }
  if (req.action === 'getStats') {
    sendResponse({ ...organizationStats });
  }
  if (req.action === 'addCurrentPage') {
    // Support override parameters for category selection or creation
    const override = {};
    if (req.category) override.category = req.category;
    if (req.newCategory) override.newCategory = req.newCategory;
    addCurrentPage(req.url, req.title, override).then((res) => sendResponse(res));
    return true;
  }
  if (req.action === 'getDashboardData') {
    getDashboardData().then((data) => sendResponse({ data })).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (req.action === 'getAllBookmarks') {
    (async () => {
      try {
        await aiService.init();
        const list = await getAllBookmarksFlat();
        const res = [];
        const store = await chrome.storage.local.get(['bookmarkMeta', 'userCategories']);
        let meta = store.bookmarkMeta || {};
        let userCategories = store.userCategories || {};
        let metaDirty = false;
        for (const bm of list) {
          let slug;
          // Use existing meta if available
          if (meta[bm.id] && meta[bm.id].primary) {
            slug = meta[bm.id].primary;
          } else {
            // Classify
            try {
              const detail = await aiService.categorizeBookmarkDetailed({ id: bm.id, title: bm.title, url: bm.url });
              slug = detail.category || 'other';
              const description = detail.description || '';
              // Add category if new
              if (slug && !userCategories[slug]) {
                const friendly = slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                userCategories[slug] = { id: slug, name: friendly, emoji: '📁', parent: null, order: Object.keys(userCategories).length + 1 };
              }
              meta[bm.id] = meta[bm.id] || {};
              meta[bm.id].primary = slug;
              meta[bm.id].description = description;
              meta[bm.id].manual = !!meta[bm.id].manual;
              metaDirty = true;
              // Move to folder
              const parentId = await ensureCategoryFolder(slug);
              await safeMove(bm.id, parentId);
            } catch {
              slug = 'other';
            }
          }
          res.push({ ...bm, category: slug, favorite: Math.random() < 0.1 });
        }
        if (metaDirty) {
          await chrome.storage.local.set({ bookmarkMeta: meta, userCategories });
        }
        sendResponse({ bookmarks: res });
      } catch (e) {
        sendResponse({ bookmarks: [] });
        console.error('getAllBookmarks failed', e);
      }
    })();
    return true;
  }
  if (req.action === 'setClassificationMode') {
    // Save classification mode and reload service
    chrome.storage.local.set({ classification_mode: req.mode }).then(async () => {
      await aiService.init();
      sendResponse({ success: true });
    });
    return true;
  }
  if (req.action === 'setApiKeys') {
    const toSave = {};
    if (req.openaiApiKey !== undefined) toSave.openai_api_key = req.openaiApiKey;
    if (req.geminiApiKey !== undefined) toSave.gemini_api_key = req.geminiApiKey;
    if (req.claudeApiKey !== undefined) toSave.claude_api_key = req.claudeApiKey;
    if (req.uclassifyApiKey !== undefined) toSave.uclassify_api_key = req.uclassifyApiKey;
    chrome.storage.local.set(toSave).then(async () => {
      await aiService.init();
      sendResponse({ success: true });
    });
    return true;
  }

  // Update bookmark categories manually.  Expects: bookmarkId, categories (array of slugs), primary (slug), tags (optional).
  if (req.action === 'updateBookmarkCategories') {
    (async () => {
      try {
        const { bookmarkId, categories, primary, tags } = req;
        // Load metadata
        const store = await chrome.storage.local.get(['bookmarkMeta']);
        const meta = store.bookmarkMeta || {};
        // Update meta for this bookmark
        meta[bookmarkId] = meta[bookmarkId] || {};
        meta[bookmarkId].categories = Array.isArray(categories) && categories.length ? categories : [primary];
        meta[bookmarkId].primary = primary;
        meta[bookmarkId].manual = true;
        if (Array.isArray(tags)) meta[bookmarkId].tags = tags;
        await chrome.storage.local.set({ bookmarkMeta: meta });
        // Move bookmark to the new primary folder if necessary
        const targetParent = await ensureCategoryFolder(primary);
        await safeMove(bookmarkId, targetParent);
        sendResponse({ success: true });
      } catch (e) {
        console.error('Failed to update bookmark categories', e);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Update bookmark metadata (single category + optional tags).
  // Expects: id, category (slug), tags (comma-separated string or array).
  if (req.action === 'updateBookmarkMeta') {
    (async () => {
      try {
        const { id, category, tags } = req;
        if (!id || !category) {
          sendResponse({ success: false, error: 'Missing id or category' });
          return;
        }
        // Load categories and meta
        const store = await chrome.storage.local.get(['userCategories', 'bookmarkMeta']);
        let userCategories = store.userCategories || {};
        let meta = store.bookmarkMeta || {};
        // Create category if it does not exist
        if (!userCategories[category]) {
          const friendly = category.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
          userCategories[category] = { id: category, name: friendly, emoji: '📁', parent: null, order: Object.keys(userCategories).length + 1 };
        }
        // Update meta for bookmark
        meta[id] = meta[id] || {};
        meta[id].primary = category;
        meta[id].manual = true;
        if (tags) {
          if (Array.isArray(tags)) meta[id].tags = tags;
          else if (typeof tags === 'string') meta[id].tags = tags.split(',').map((t) => t.trim()).filter((t) => t);
        }
        // Save user categories and meta
        await chrome.storage.local.set({ userCategories, bookmarkMeta: meta });
        // Move the bookmark into the category folder
        const folderId = await ensureCategoryFolder(category);
        await safeMove(id, folderId);
        sendResponse({ success: true });
      } catch (e) {
        console.error('updateBookmarkMeta failed', e);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Update user categories structure.  Expects: userCategories (object)
  if (req.action === 'updateUserCategories') {
    (async () => {
      try {
        const { userCategories: newCats } = req;
        // Load existing categories and bookmark metadata
        const store = await chrome.storage.local.get(['userCategories', 'bookmarkMeta']);
        const oldCats = store.userCategories || {};
        let meta = store.bookmarkMeta || {};
        // Identify removed categories (present in oldCats but not in newCats)
        const removed = Object.keys(oldCats).filter((slug) => !newCats[slug]);
        // Fallback category for reassignment
        const fallbackSlug = newCats.other ? 'other' : Object.keys(newCats)[0] || null;
        // Remove bookmarks and update meta for removed categories
        if (removed.length) {
          const smartId = await getSmartParentId();
          // Build map of folder names to ids for old categories
          const children = await new Promise((resolve) => {
            chrome.bookmarks.getChildren(smartId, (c) => resolve(c || []));
          });
          const folderNameToId = {};
          for (const slug of removed) {
            const oc = oldCats[slug];
            const fName = `${oc.emoji ? oc.emoji + ' ' : ''}${oc.name}`;
            for (const child of children) {
              if (!child.url && child.title === fName) {
                folderNameToId[slug] = child.id;
                break;
              }
            }
          }
          // Iterate removed folders: move bookmarks to fallback and remove folder
          for (const slug of removed) {
            const folderId = folderNameToId[slug];
            if (!folderId) continue;
            // Get children of the folder
            const bmChildren = await new Promise((resolve) => {
              chrome.bookmarks.getChildren(folderId, (c) => resolve(c || []));
            });
            for (const child of bmChildren) {
              if (child.url) {
                // Update meta: remove slug from categories
                if (meta[child.id]) {
                  const cats = meta[child.id].categories || [];
                  meta[child.id].categories = cats.filter((c) => c !== slug);
                  // Reassign primary if necessary
                  if (meta[child.id].primary === slug) {
                    const newPrimary = meta[child.id].categories[0] || fallbackSlug;
                    meta[child.id].primary = newPrimary;
                  }
                  meta[child.id].manual = true;
                }
                // Move bookmark to fallback folder
                if (fallbackSlug) {
                  const parentFolderId = await ensureCategoryFolder(fallbackSlug);
                  await safeMove(child.id, parentFolderId);
                }
              }
            }
            // Remove the empty folder
            await new Promise((resolve) => {
              chrome.bookmarks.removeTree(folderId, () => resolve());
            });
          }
        }
        // Save updated meta
        await chrome.storage.local.set({ bookmarkMeta: meta });
        // Save new categories
        await chrome.storage.local.set({ userCategories: newCats });
        // Ensure folders exist for new categories
        await ensureUserCategoryFolders();
        sendResponse({ success: true });
      } catch (e) {
        console.error('Failed to update user categories', e);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }
  return false;
});

// Ensure state is loaded on service worker startup (e.g., when browser opens)
chrome.runtime.onStartup.addListener(async () => {
  try {
    await loadState();
    // Do not create folders on startup; they will be created when categories are used
  } catch (e) {
    console.warn('Failed loading state on startup', e);
  }
});
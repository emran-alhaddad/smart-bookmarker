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

// Check if a bookmark is already in the Smart Bookmarks folder structure
async function isBookmarkInSmartStructure(bookmarkId) {
  return new Promise((resolve) => {
    function checkParents(id) {
      chrome.bookmarks.get(id, (results) => {
        if (chrome.runtime.lastError || !results || !results[0]) {
          resolve(false);
          return;
        }
        
        const bookmark = results[0];
        
        // If we're at the root, it's not in smart structure
        if (!bookmark.parentId) {
          resolve(false);
          return;
        }
        
        // Check if the parent is the Smart Bookmarks folder
        chrome.bookmarks.get(bookmark.parentId, (parentResults) => {
          if (chrome.runtime.lastError || !parentResults || !parentResults[0]) {
            resolve(false);
            return;
          }
          
          const parent = parentResults[0];
          
          // If parent is Smart Bookmarks folder
          if (parent.title === SMART_PARENT) {
            resolve(true);
            return;
          }
          
          // If parent has no parent, we've reached root without finding Smart Bookmarks
          if (!parent.parentId) {
            resolve(false);
            return;
          }
          
          // Check the parent's parent recursively
          checkParents(parent.parentId);
        });
      });
    }
    
    checkParents(bookmarkId);
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
  // Prevent multiple concurrent organizations
  if (orgState.status === 'running') {
    console.log('Organization already running, skipping...');
    return { success: false, error: 'Already organizing' };
  }
  
  try {
    // Load classification settings
    await aiService.init();
    
    // Compute list of bookmarks to process (HTTP(S) only, not already in smart parent)
    const list = await getAllBookmarksFlat();
    const smartParentId = await getSmartParentId();
    
    // Filter out bookmarks that are already in smart folders or invalid URLs
    const toProcess = [];
    for (const b of list) {
      // Skip if already in smart parent structure
      if (b.parentId === smartParentId) continue;
      
      // Check if bookmark is in a subfolder of smart parent using path
      const isInSmartStructure = b.path && b.path.some(p => p.title === SMART_PARENT);
      if (isInSmartStructure) continue;
      
      toProcess.push(b);
    }
    
    console.log(`Found ${toProcess.length} bookmarks to organize (out of ${list.length} total)`);
    
    if (toProcess.length === 0) {
      return { success: true, message: 'No bookmarks need organizing' };
    }
    
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
    
    // Process sequentially with error handling for each bookmark
    for (let i = 0; i < toProcess.length; i++) {
      const bm = toProcess[i];
      
      // Check if organization was cancelled
      if (orgState.status !== 'running') {
        console.log('Organization cancelled');
        break;
      }
      
      try {
        // Skip if bookmark already has classification and we're not forcing reclassification
        let slug, description;
        if (meta[bm.id] && meta[bm.id].primary && !meta[bm.id].needsReclassification) {
          slug = meta[bm.id].primary;
          description = meta[bm.id].description || '';
        } else {
          // Use the AI service to classify this bookmark
          const result = await aiService.categorizeBookmarkDetailed({ 
            id: bm.id, 
            title: bm.title, 
            url: bm.url 
          });
          slug = result.category || 'other';
          description = result.description || '';
        }
        
        // Validate and normalize slug
        if (!slug || slug.trim() === '') {
          slug = 'other';
        }
        slug = slug.toLowerCase().trim();
        
        // Add new user category if slug not present
        if (!userCategories[slug]) {
          const friendly = slug.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
          userCategories[slug] = { 
            id: slug, 
            name: friendly, 
            emoji: '📁', 
            parent: null, 
            order: Object.keys(userCategories).length + 1 
          };
        }
        
        // Persist classification for this original bookmark
        meta[bm.id] = meta[bm.id] || {};
        meta[bm.id].primary = slug;
        meta[bm.id].description = description || '';
        meta[bm.id].manual = !!meta[bm.id].manual;
        meta[bm.id].organized = true;
        meta[bm.id].organizedAt = Date.now();
        delete meta[bm.id].needsReclassification;
        
        // Ensure category folder exists
        const targetParent = await ensureCategoryFolder(slug);
        
        if (strategy === 'move') {
          // Move original bookmark into the category folder
          await safeMove(bm.id, targetParent);
        } else {
          // Clone: create a new bookmark in the category folder without moving original
          try {
            const newBm = await new Promise((resolve, reject) => {
              chrome.bookmarks.create({ 
                parentId: targetParent, 
                title: bm.title, 
                url: bm.url 
              }, (result) => {
                if (chrome.runtime.lastError) {
                  reject(chrome.runtime.lastError);
                } else {
                  resolve(result);
                }
              });
            });
            
            // Persist meta for the clone
            meta[newBm.id] = {
              primary: slug,
              description: description || '',
              manual: false,
              organized: true,
              organizedAt: Date.now(),
              clonedFrom: bm.id
            };
          } catch (cloneError) {
            console.error(`Failed to clone bookmark ${bm.title}:`, cloneError);
            continue; // Skip this bookmark but continue with others
          }
        }
        
        // Update stats
        organizationStats.categories[slug] = (organizationStats.categories[slug] || 0) + 1;
        if (bm.dateAdded && bm.dateAdded > weekAgo) {
          organizationStats.recent += 1;
        }
        
      } catch (error) {
        console.error(`Error organizing bookmark "${bm.title}" (${bm.url}):`, error);
        
        // Mark as failed but continue
        meta[bm.id] = meta[bm.id] || {};
        meta[bm.id].organizeFailed = true;
        meta[bm.id].lastError = error.message;
      }
      
      // Update progress
      orgState.done = i + 1;
      orgState.lastTitle = bm.title;
      await saveOrgState();
      
      // Broadcast progress after each bookmark is processed
      broadcastProgress({ 
        status: 'running', 
        done: orgState.done, 
        total: orgState.total 
      });
      
      // Add small delay to prevent overwhelming the system
      if (i % 10 === 0 && i > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // Save updated metadata and user categories
    await chrome.storage.local.set({ bookmarkMeta: meta, userCategories });
    
    // Remove duplicates if using clone strategy
    if (strategy === 'clone') {
      console.log('Removing duplicates from Smart Bookmarks...');
      broadcastProgress({ 
        status: 'running', 
        done: orgState.total, 
        total: orgState.total,
        message: 'Removing duplicates...'
      });
      
      const dedupeResult = await removeDuplicatesFromSmartBookmarks();
      if (dedupeResult.success) {
        console.log(`Duplicate removal completed: ${dedupeResult.duplicatesRemoved} duplicates removed`);
      } else {
        console.error('Duplicate removal failed:', dedupeResult.error);
      }
    }
    
    // Mark as completed
    orgState.status = 'done';
    orgState.completedAt = Date.now();
    await saveOrgState();
    
    // Broadcast final progress state
    broadcastProgress({ 
      status: 'done', 
      done: orgState.total, 
      total: orgState.total 
    });
    
    organizationStats.categoriesCreated = Object.keys(organizationStats.categories).length;
    await saveStats();
    
    console.log(`Organization completed: ${orgState.total} bookmarks processed, ${organizationStats.categoriesCreated} categories created`);
    
    return { success: true, stats: organizationStats };
    
  } catch (error) {
    console.error('Organization failed:', error);
    
    // Mark as failed
    orgState.status = 'failed';
    orgState.error = error.message;
    await saveOrgState();
    
    broadcastProgress({ 
      status: 'failed', 
      done: orgState.done, 
      total: orgState.total, 
      error: error.message 
    });
    
    return { success: false, error: error.message };
  }
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
  const list = await getAllBookmarksFlat();
  const result = {};
  
  // Load user categories and metadata
  const store = await chrome.storage.local.get(['userCategories', 'bookmarkMeta']);
  let userCategories = store.userCategories || {};
  let meta = store.bookmarkMeta || {};
  
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
      // Use existing classification without auto-organizing
      slug = meta[bm.id].primary;
      description = meta[bm.id].description || '';
    } else {
      // For unclassified bookmarks, just show them as 'Uncategorized' 
      // Don't auto-classify here - only when user explicitly organizes
      slug = 'uncategorized';
      description = 'Not yet organized';
    }
    
    // Ensure category exists in display
    if (!userCategories[slug] && slug !== 'uncategorized') {
      const friendly = slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      userCategories[slug] = { id: slug, name: friendly, emoji: '📁', parent: null, order: Object.keys(userCategories).length + 1 };
    }
    
    const cat = slug === 'uncategorized' 
      ? { name: 'Uncategorized', emoji: '❓' }
      : (userCategories[slug] || { name: slug, emoji: '📁' });
    
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

// Remove duplicates from Smart Bookmarks folder while keeping originals
async function removeDuplicatesFromSmartBookmarks() {
  try {
    console.log('Starting duplicate removal from Smart Bookmarks...');
    
    const smartParentId = await getSmartParentId();
    const allBookmarks = await getAllBookmarksFlat();
    
    // Get all bookmarks in Smart Bookmarks structure
    const smartBookmarks = [];
    const regularBookmarks = [];
    
    for (const bm of allBookmarks) {
      const isInSmart = bm.path && bm.path.some(p => p.title === SMART_PARENT);
      if (isInSmart || bm.parentId === smartParentId) {
        smartBookmarks.push(bm);
      } else {
        regularBookmarks.push(bm);
      }
    }
    
    console.log(`Found ${smartBookmarks.length} bookmarks in Smart Bookmarks, ${regularBookmarks.length} regular bookmarks`);
    
    // Create URL map for regular bookmarks (originals)
    const originalUrls = new Set();
    regularBookmarks.forEach(bm => {
      if (bm.url) {
        // Normalize URL for comparison
        const normalizedUrl = normalizeUrl(bm.url);
        originalUrls.add(normalizedUrl);
      }
    });
    
    // Find duplicates within Smart Bookmarks
    const urlToBookmarks = new Map();
    const duplicatesToRemove = [];
    
    smartBookmarks.forEach(bm => {
      if (!bm.url) return;
      
      const normalizedUrl = normalizeUrl(bm.url);
      const key = `${normalizedUrl}|${(bm.title || '').trim()}`;
      
      if (!urlToBookmarks.has(key)) {
        urlToBookmarks.set(key, []);
      }
      urlToBookmarks.get(key).push(bm);
    });
    
    // Also check for URL-only duplicates (different titles, same URL)
    const urlOnlyMap = new Map();
    smartBookmarks.forEach(bm => {
      if (!bm.url) return;
      
      const normalizedUrl = normalizeUrl(bm.url);
      
      if (!urlOnlyMap.has(normalizedUrl)) {
        urlOnlyMap.set(normalizedUrl, []);
      }
      urlOnlyMap.get(normalizedUrl).push(bm);
    });
    
    // Identify duplicates to remove
    let duplicatesFound = 0;
    let duplicatesRemoved = 0;
    
    // Process exact matches (same URL and title)
    for (const [key, bookmarks] of urlToBookmarks) {
      if (bookmarks.length > 1) {
        duplicatesFound += bookmarks.length - 1;
        
        // Sort by date added (keep the oldest one)
        bookmarks.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
        
        // Mark all but the first (oldest) for removal
        for (let i = 1; i < bookmarks.length; i++) {
          duplicatesToRemove.push(bookmarks[i]);
        }
      }
    }
    
    // Process URL-only matches (same URL, different titles) - more conservative
    for (const [url, bookmarks] of urlOnlyMap) {
      if (bookmarks.length > 1) {
        // Group by title first to avoid removing bookmarks with meaningful title differences
        const titleGroups = new Map();
        bookmarks.forEach(bm => {
          const titleKey = (bm.title || '').trim().toLowerCase();
          if (!titleGroups.has(titleKey)) {
            titleGroups.set(titleKey, []);
          }
          titleGroups.get(titleKey).push(bm);
        });
        
        // Only remove if there are true duplicates within title groups
        // or if titles are very similar (indicating true duplicates)
        for (const [titleKey, titleBookmarks] of titleGroups) {
          if (titleBookmarks.length > 1) {
            duplicatesFound += titleBookmarks.length - 1;
            
            // Sort by date added (keep the oldest one)
            titleBookmarks.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
            
            // Mark all but the first (oldest) for removal
            for (let i = 1; i < titleBookmarks.length; i++) {
              // Avoid double-adding to removal list
              if (!duplicatesToRemove.find(d => d.id === titleBookmarks[i].id)) {
                duplicatesToRemove.push(titleBookmarks[i]);
              }
            }
          }
        }
      }
    }
    
    console.log(`Found ${duplicatesFound} duplicate bookmarks to remove`);
    
    // Remove duplicates
    for (const duplicate of duplicatesToRemove) {
      try {
        await new Promise((resolve, reject) => {
          chrome.bookmarks.remove(duplicate.id, () => {
            if (chrome.runtime.lastError) {
              console.error(`Failed to remove duplicate ${duplicate.title}:`, chrome.runtime.lastError);
              reject(chrome.runtime.lastError);
            } else {
              duplicatesRemoved++;
              resolve();
            }
          });
        });
        
        // Remove metadata for deleted bookmark
        const metaStore = await chrome.storage.local.get(['bookmarkMeta']);
        const meta = metaStore.bookmarkMeta || {};
        if (meta[duplicate.id]) {
          delete meta[duplicate.id];
          await chrome.storage.local.set({ bookmarkMeta: meta });
        }
        
      } catch (error) {
        console.error(`Failed to remove duplicate bookmark ${duplicate.title}:`, error);
      }
    }
    
    console.log(`Successfully removed ${duplicatesRemoved} duplicate bookmarks`);
    
    return {
      success: true,
      duplicatesFound,
      duplicatesRemoved,
      smartBookmarksTotal: smartBookmarks.length,
      originalBookmarksTotal: regularBookmarks.length
    };
    
  } catch (error) {
    console.error('Failed to remove duplicates:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Normalize URL for duplicate detection
function normalizeUrl(url) {
  try {
    const urlObj = new URL(url);
    
    // Remove common tracking parameters
    const paramsToRemove = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'fbclid', 'gclid', 'ref', 'source', 'campaign_id', 'ad_id',
      'track', 'tracking', 'campaign', 'medium'
    ];
    
    paramsToRemove.forEach(param => {
      urlObj.searchParams.delete(param);
    });
    
    // Remove trailing slash and www
    let normalizedUrl = urlObj.toString().replace(/\/$/, '');
    normalizedUrl = normalizedUrl.replace(/^https?:\/\/www\./, 'https://');
    
    return normalizedUrl.toLowerCase();
  } catch {
    // If URL parsing fails, return original URL lowercased
    return url.toLowerCase().trim();
  }
}
async function resetOrganizeState() {
  orgState = {
    status: 'idle',
    total: 0,
    done: 0,
    startedAt: null,
    lastTitle: null,
    provider: 'local'
  };
  await saveOrgState();
  await chrome.storage.local.remove('organize_progress');
  broadcastProgress({ status: 'idle', done: 0, total: 0 });
}

// Message API for popup/options/dashboard
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action === 'startOrganize') {
    startOrganize().then((result) => sendResponse(result)).catch((error) => {
      console.error('Start organize failed:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  if (req.action === 'resetOrganizeState') {
    resetOrganizeState().then(() => sendResponse({ success: true }));
    return true;
  }
  if (req.action === 'removeDuplicates') {
    removeDuplicatesFromSmartBookmarks().then((result) => sendResponse(result));
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
        const list = await getAllBookmarksFlat();
        const res = [];
        const store = await chrome.storage.local.get(['bookmarkMeta', 'userCategories']);
        let meta = store.bookmarkMeta || {};
        let userCategories = store.userCategories || {};
        
        for (const bm of list) {
          let slug;
          // Use existing meta if available, don't auto-classify
          if (meta[bm.id] && meta[bm.id].primary) {
            slug = meta[bm.id].primary;
          } else {
            // Show as uncategorized instead of auto-classifying
            slug = 'uncategorized';
          }
          res.push({ ...bm, category: slug, favorite: Math.random() < 0.1 });
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
// Popup UI logic for Smart Bookmark Organizer
//
// This script powers the popup: displays bookmark counts, lists bookmarks
// grouped or in grid view, triggers organization with progress tracking,
// quick add for arbitrary URLs, and provides links to the dashboard and
// settings pages.

// DOM elements
const totalCountEl = document.getElementById('totalCount');
const categoriesCountEl = document.getElementById('categoriesCount');
const favoritesCountEl = document.getElementById('favoritesCount');
const recentCountEl = document.getElementById('recentCount');
const urlInput = document.getElementById('urlInput');
const quickAddBtn = document.getElementById('quickAddBtn');
const searchInput = document.getElementById('searchInput');
const filterBtn = document.getElementById('filterBtn');
const bookmarkStatsEl = document.getElementById('bookmarkStats');
const foldersViewBtn = document.getElementById('foldersView');
const gridViewBtn = document.getElementById('gridView');
const bookmarksGrid = document.getElementById('bookmarksGrid');
const organizeBtn = document.getElementById('organizeBtn');
const addCurrentBtn = document.getElementById('addCurrentBtn');
const statusEl = document.getElementById('status');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const dashboardBtn = document.getElementById('dashboardBtn');
const settingsBtn = document.getElementById('settingsBtn');

// State
let currentBookmarks = [];
let currentView = 'grid';
let searchQuery = '';
let progressPoller = null;

// Listen for live progress updates from the background.  The background
// broadcasts progress state via chrome.runtime.sendMessage({ action: 'organizeProgress', state }).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.action === 'organizeProgress') {
    updateProgress(msg.state);
  }
});

// Category styles (must align with CSS or custom settings)
const categoryConfig = {
  'AI Tools': { color: '#ef4444', icon: '🤖' },
  'Programming': { color: '#3b82f6', icon: '💻' },
  'Frontend': { color: '#10b981', icon: '🎨' },
  'Backend': { color: '#f59e0b', icon: '⚙️' },
  'QA': { color: '#8b5cf6', icon: '🧪' },
  'Database': { color: '#06b6d4', icon: '🗄️' },
  'DevOps': { color: '#f97316', icon: '🚀' },
  'Design': { color: '#ec4899', icon: '🎭' },
  'UX/UI': { color: '#ec4899', icon: '🎭' },
  'Documentation': { color: '#6b7280', icon: '📚' },
  'uncategorized': { color: '#64748b', icon: '❓' },
  'Other': { color: '#64748b', icon: '📄' }
};

// Restore organize UI state on popup load. If an organization is already running,
// update the button and progress bar accordingly and continue polling.
async function restoreOrganizeUi() {
  try {
    const state = await chrome.runtime.sendMessage({ action: 'getProgress' });
    if (state && state.status === 'running') {
      updateProgress(state);
      pollProgress();
      organizeBtn.disabled = true;
      organizeBtn.innerHTML = '<span class="loading"></span> <span>Organizing...</span>';
    } else {
      organizeBtn.disabled = false;
      organizeBtn.innerHTML = '<span class="btn-icon">🤖</span> <span>Organize All Bookmarks</span>';
    }
  } catch {
    // ignore
  }
}

// Event handlers
organizeBtn.addEventListener('click', async () => {
  organizeBtn.disabled = true;
  organizeBtn.innerHTML = '<span class="loading"></span> <span>Organizing...</span>';
  showStatus('Starting organization...', 'info');
  try {
    await chrome.runtime.sendMessage({ action: 'startOrganize' });
    pollProgress();
  } catch (e) {
    showStatus('Failed to start organization', 'error');
    organizeBtn.disabled = false;
    organizeBtn.innerHTML = '<span class="btn-icon">🤖</span> <span>Organize All Bookmarks</span>';
  }
});

addCurrentBtn.addEventListener('click', async () => {
  addCurrentBtn.disabled = true;
  addCurrentBtn.innerHTML = '<span class="loading"></span> <span>Adding...</span>';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) throw new Error('No active tab');
    // Prompt user for how to categorize: auto, pick existing or create new
    let mode = prompt('Choose how to categorize this page:\n- auto\n- pick\n- create', 'auto');
    if (!mode) mode = 'auto';
    mode = mode.trim().toLowerCase();
    const override = {};
    if (mode === 'pick') {
      // Ask for category slug
      const catsStore = await chrome.storage.local.get(['userCategories']);
      const cats = catsStore.userCategories || {};
      const slug = prompt('Enter existing category slug (e.g., tools or developer/frontend):');
      if (slug && cats[slug]) {
        override.category = slug;
      } else {
        alert('Unknown category; will auto-categorize.');
      }
    } else if (mode === 'create') {
      const id = prompt('Enter new slug (e.g., tools/ai-tools):');
      if (id) {
        const name = prompt('Enter name (e.g., AI Tools):', id);
        const emoji = prompt('Emoji (optional):', '📁');
        let parent = null;
        if (id.includes('/')) parent = id.split('/')[0];
        override.newCategory = { id: id.trim().toLowerCase(), name: name || id, emoji: emoji || '📁', parent: parent || null, order: 999 };
      }
    }
    const res = await chrome.runtime.sendMessage({ action: 'addCurrentPage', url: tab.url, title: tab.title, ...override });
    if (res && res.success) {
      showStatus(`Added to ${res.category} category!`, 'success');
      await loadBookmarks();
      await updateStats();
    } else {
      showStatus('Error adding bookmark', 'error');
    }
  } catch (e) {
    showStatus('Error adding bookmark', 'error');
  }
  addCurrentBtn.disabled = false;
  addCurrentBtn.innerHTML = '<span class="btn-icon">⭐</span> <span>Add Current Page</span>';
});

quickAddBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) return;
  quickAddBtn.disabled = true;
  quickAddBtn.innerHTML = '<span class="loading"></span>';
  try {
    const title = extractTitleFromUrl(url);
    const res = await chrome.runtime.sendMessage({ action: 'addCurrentPage', url, title });
    if (res && res.success) {
      showStatus(`Added to ${res.category} category!`, 'success');
      urlInput.value = '';
      await loadBookmarks();
      await updateStats();
    } else {
      showStatus('Error adding bookmark', 'error');
    }
  } catch (e) {
    showStatus('Error adding bookmark', 'error');
  }
  quickAddBtn.disabled = false;
  quickAddBtn.innerHTML = '✨';
});

searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value.toLowerCase();
  renderBookmarks();
});

gridViewBtn.addEventListener('click', () => {
  currentView = 'grid';
  gridViewBtn.classList.add('active');
  foldersViewBtn.classList.remove('active');
  renderBookmarks();
});

foldersViewBtn.addEventListener('click', () => {
  currentView = 'folders';
  foldersViewBtn.classList.add('active');
  gridViewBtn.classList.remove('active');
  renderBookmarks();
});

dashboardBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// Polling for progress
function pollProgress() {
  if (progressPoller) clearInterval(progressPoller);
  progressPoller = setInterval(async () => {
    try {
      const state = await chrome.runtime.sendMessage({ action: 'getProgress' });
      updateProgress(state);
      
      if (!state || (state.status !== 'running')) {
        clearInterval(progressPoller);
        organizeBtn.disabled = false;
        
        if (state && state.status === 'failed') {
          organizeBtn.innerHTML = '<span class="btn-icon">❌</span> <span>Organization Failed</span>';
          showStatus(`Organization failed: ${state.error || 'Unknown error'}`, 'error');
          
          // Reset after a delay
          setTimeout(() => {
            organizeBtn.innerHTML = '<span class="btn-icon">🤖</span> <span>Organize All Bookmarks</span>';
          }, 5000);
        } else {
          organizeBtn.innerHTML = '<span class="btn-icon">🤖</span> <span>Organize All Bookmarks</span>';
          if (state && state.status === 'done') {
            showStatus('Organization completed successfully!', 'success');
          }
        }
        
        // Reload data after completion or failure
        loadBookmarks();
        updateStats();
      }
    } catch (error) {
      console.error('Failed to poll progress:', error);
      clearInterval(progressPoller);
      organizeBtn.disabled = false;
      organizeBtn.innerHTML = '<span class="btn-icon">🤖</span> <span>Organize All Bookmarks</span>';
    }
  }, 1200);
}

function updateProgress(state) {
  if (!state || state.status === 'idle' || state.total === 0) {
    progressContainer.style.display = 'none';
    return;
  }
  
  progressContainer.style.display = 'block';
  const percentage = state.total ? Math.round((state.done / state.total) * 100) : 0;
  progressBar.style.width = `${percentage}%`;
  
  if (state.status === 'failed') {
    progressText.textContent = `Failed: ${state.done}/${state.total}`;
    progressBar.style.background = 'linear-gradient(90deg, #ef4444, #dc2626)';
  } else if (state.status === 'done') {
    progressText.textContent = `Complete: ${state.done}/${state.total}`;
    progressBar.style.background = 'linear-gradient(90deg, #34d399, #10b981)';
    // Hide progress after completion
    setTimeout(() => {
      progressContainer.style.display = 'none';
    }, 3000);
  } else {
    progressText.textContent = `${state.done}/${state.total}`;
    progressBar.style.background = 'linear-gradient(90deg, #34d399, #10b981)';
  }
}

// Load bookmarks from background
async function loadBookmarks() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getAllBookmarks' });
    if (res && res.bookmarks) {
      currentBookmarks = res.bookmarks;
      renderBookmarks();
    }
  } catch (e) {
    console.error('Error loading bookmarks', e);
  }
}

function renderBookmarks() {
  const filtered = currentBookmarks.filter((bookmark) => {
    if (!searchQuery) return true;
    return bookmark.title.toLowerCase().includes(searchQuery) ||
           bookmark.url.toLowerCase().includes(searchQuery) ||
           (bookmark.category && bookmark.category.toLowerCase().includes(searchQuery));
  });
  if (currentView === 'grid') {
    renderGridView(filtered);
  } else {
    renderFoldersView(filtered);
  }
}

function renderGridView(bookmarks) {
  bookmarksGrid.innerHTML = '';
  bookmarks.forEach((bookmark) => {
    const category = bookmark.category || 'Other';
    const cfg = categoryConfig[category] || categoryConfig['Other'];
    const card = document.createElement('div');
    card.className = 'bookmark-card';
    card.innerHTML = `
      <div class="bookmark-header">
        <div class="bookmark-icon" style="background:${cfg.color}20; color:${cfg.color}">${cfg.icon}</div>
        <div class="bookmark-title">${bookmark.title}</div>
        ${bookmark.favorite ? '<div class="bookmark-favorite">⭐</div>' : ''}
      </div>
      <div class="bookmark-url">${bookmark.url}</div>
      <div class="bookmark-category" style="background:${cfg.color}20; color:${cfg.color}">${category}</div>
      <div class="bookmark-tags">
        ${generateTags(bookmark).map((t) => `<span class="bookmark-tag">${t}</span>`).join('')}
      </div>
    `;
    card.addEventListener('click', () => {
      chrome.tabs.create({ url: bookmark.url });
    });
    bookmarksGrid.appendChild(card);
  });
}

function renderFoldersView(bookmarks) {
  const groups = {};
  bookmarks.forEach((b) => {
    const category = b.category || 'Other';
    if (!groups[category]) groups[category] = [];
    groups[category].push(b);
  });
  bookmarksGrid.innerHTML = '';
  Object.entries(groups).forEach(([cat, items]) => {
    const cfg = categoryConfig[cat] || categoryConfig['Other'];
    const folder = document.createElement('div');
    folder.className = 'bookmark-card';
    folder.innerHTML = `
      <div class="bookmark-header">
        <div class="bookmark-icon" style="background:${cfg.color}20; color:${cfg.color}">${cfg.icon}</div>
        <div class="bookmark-title">${cat}</div>
      </div>
      <div class="bookmark-url">${items.length} bookmarks</div>
      <div class="bookmark-category" style="background:${cfg.color}20; color:${cfg.color}">Folder</div>
    `;
    folder.addEventListener('click', () => {
      // expand folder: open new tab listing category items
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html#' + encodeURIComponent(cat)) });
    });
    bookmarksGrid.appendChild(folder);
  });
}

function generateTags(bookmark) {
  const tags = [];
  const url = bookmark.url.toLowerCase();
  const title = bookmark.title.toLowerCase();
  if (url.includes('github.com')) tags.push('github');
  if (url.includes('stackoverflow.com')) tags.push('stackoverflow');
  if (url.includes('docs') || title.includes('docs')) tags.push('docs');
  if (url.includes('api') || title.includes('api')) tags.push('api');
  if (title.includes('tutorial')) tags.push('tutorial');
  if (title.includes('guide')) tags.push('guide');
  return tags.slice(0, 3);
}

async function updateStats() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getStats' });
    if (res) {
      totalCountEl.textContent = res.totalBookmarks || 0;
      categoriesCountEl.textContent = Object.keys(res.categories || {}).length;
      favoritesCountEl.textContent = res.favorites || 0;
      recentCountEl.textContent = res.recent || 0;
      const total = res.totalBookmarks || 0;
      const cats = Object.keys(res.categories || {}).length;
      bookmarkStatsEl.textContent = `${cats} categories, ${total} bookmarks`;
    }
  } catch (e) {
    console.error('Error getting stats', e);
  }
}

function showStatus(message, type = 'info') {
  statusEl.textContent = message;
  statusEl.className = `status-message ${type}`;
  statusEl.style.display = 'block';
  setTimeout(() => {
    statusEl.style.display = 'none';
  }, 3000);
}

function extractTitleFromUrl(url) {
  try {
    const u = new URL(url);
    const hostname = u.hostname.replace('www.', '');
    return hostname.charAt(0).toUpperCase() + hostname.slice(1);
  } catch {
    return url;
  }
}

// On load
document.addEventListener('DOMContentLoaded', async () => {
  await loadBookmarks();
  await updateStats();
  // Restore organize button state if a reorganization is in progress
  await restoreOrganizeUi();
  // Preload current page placeholder
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && !tab.url.startsWith('chrome://')) {
      urlInput.placeholder = `Add: ${tab.title || tab.url}`;
    }
  } catch {}
  // The button state and progress are restored via restoreOrganizeUi above
});
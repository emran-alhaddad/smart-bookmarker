// Options page script for Smart Bookmark Organizer
//
// Loads and saves classification settings, API keys, rate limits,
// custom categories and displays current category counts.  Provides
// import/export functionality for easy migration.

// Select DOM elements
const classificationModeSelect = document.getElementById('classificationMode');
const openaiKeyInput = document.getElementById('openaiKey');
const geminiKeyInput = document.getElementById('geminiKey');
const claudeKeyInput = document.getElementById('claudeKey');
const uclassifyKeyInput = document.getElementById('uclassifyKey');
const rateLimitDelayInput = document.getElementById('rateLimitDelay');
const customCategoriesInput = document.getElementById('customCategories');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importFile = document.getElementById('importFile');
const statusEl = document.getElementById('status');
// Organize strategy radios
const keepOriginalsRadio = document.getElementById('keepOriginals');
const moveOriginalsRadio = document.getElementById('moveOriginals');
// Elements for user category management
const userCategoriesListEl = document.getElementById('userCategoriesList');
const addCategoryBtn = document.getElementById('addCategoryBtn');
const saveCategoriesBtn = document.getElementById('saveCategoriesBtn');
// New category input fields
const newCatNameInput = document.getElementById('newCatName');
const newCatEmojiInput = document.getElementById('newCatEmoji');
const newCatParentSelect = document.getElementById('newCatParent');

// Initialise options page once the DOM is ready.
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  loadUserCategories();
  // Bind strategy radio changes
  keepOriginalsRadio?.addEventListener('change', async () => {
    if (keepOriginalsRadio.checked) {
      await chrome.storage.local.set({ organize_strategy: 'clone' });
      showStatus('Organize strategy: Keep originals (clone)', 'success');
    }
  });
  moveOriginalsRadio?.addEventListener('change', async () => {
    if (moveOriginalsRadio.checked) {
      await chrome.storage.local.set({ organize_strategy: 'move' });
      showStatus('Organize strategy: Move originals', 'success');
    }
  });
});

async function loadSettings() {
  try {
    const data = await chrome.storage.local.get([
      'classification_mode',
      'openai_api_key',
      'gemini_api_key',
      'claude_api_key',
      'uclassify_api_key',
      'rate_limit_delay',
      'custom_categories',
      'organization_stats'
    ]);
    classificationModeSelect.value = data.classification_mode || 'local';
    if (data.openai_api_key) openaiKeyInput.placeholder = 'Key saved (hidden)';
    if (data.gemini_api_key) geminiKeyInput.placeholder = 'Key saved (hidden)';
    if (data.claude_api_key) claudeKeyInput.placeholder = 'Key saved (hidden)';
    if (data.uclassify_api_key) uclassifyKeyInput.placeholder = 'Key saved (hidden)';
    rateLimitDelayInput.value = data.rate_limit_delay || 2000;
    customCategoriesInput.value = (data.custom_categories || []).join('\n');
    // Do not display default statistics on the options page. Category management is handled via the list below.

    // Load organize strategy (clone vs move)
    const stratData = await chrome.storage.local.get(['organize_strategy']);
    const strategy = stratData.organize_strategy || 'clone';
    if (strategy === 'move') {
      moveOriginalsRadio.checked = true;
    } else {
      keepOriginalsRadio.checked = true;
    }
  } catch (e) {
    showStatus('Error loading settings', 'error');
    console.error(e);
  }
}

// Removed displayCategories and displayDefaultCategories: we no longer show default
// category statistics on the options page. Instead, the categories defined
// by the user appear in the editable list below.

// Load user-defined categories from storage and render the editable list
async function loadUserCategories() {
  try {
    const data = await chrome.storage.local.get(['userCategories']);
    const cats = data.userCategories || {};
    renderUserCategories(cats);
  } catch (e) {
    console.error('Failed to load user categories', e);
  }
}

// Render editable rows for each user category
function renderUserCategories(cats) {
  userCategoriesListEl.innerHTML = '';
  const arr = Object.values(cats).sort((a, b) => (a.order || 0) - (b.order || 0));
  arr.forEach((cat) => {
    const row = document.createElement('div');
    row.className = 'cat-row';
    row.dataset.id = cat.id;
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '8px';
    row.style.marginBottom = '8px';
    // Emoji input
    const emojiInput = document.createElement('input');
    emojiInput.type = 'text';
    emojiInput.value = cat.emoji || '';
    emojiInput.className = 'emoji-input';
    emojiInput.style.width = '50px';
    emojiInput.placeholder = '😀';
    // Name input
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = cat.name || '';
    nameInput.className = 'name-input';
    nameInput.style.flex = '1';
    nameInput.placeholder = 'Category name';
    // Parent select (for sub-categories)
    const parentSelect = document.createElement('select');
    parentSelect.className = 'parent-select';
    parentSelect.style.minWidth = '120px';
    // We'll populate options later via updateParentSelectOptions()
    // Delete button
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn secondary delete-category-btn';
    delBtn.textContent = 'Delete';
    // Append
    row.appendChild(emojiInput);
    row.appendChild(nameInput);
    row.appendChild(parentSelect);
    row.appendChild(delBtn);
    userCategoriesListEl.appendChild(row);
  });
  updateParentSelectOptions();
}

// Populate parent select options for all rows based on current list
function updateParentSelectOptions() {
  const rows = userCategoriesListEl.querySelectorAll('.cat-row');
  // Gather current slugs and names
  const tempCats = [];
  rows.forEach((row) => {
    const name = row.querySelector('.name-input').value.trim();
    const emoji = row.querySelector('.emoji-input').value.trim();
    const id = row.dataset.id || '';
    tempCats.push({ id, name, emoji });
  });
  rows.forEach((row) => {
    const select = row.querySelector('.parent-select');
    const currentVal = select.value || '';
    // Clear options
    select.innerHTML = '';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '(none)';
    select.appendChild(noneOpt);
    tempCats.forEach((cat) => {
      // A category cannot be its own parent
      if (cat.id && cat.id !== row.dataset.id) {
        const opt = document.createElement('option');
        opt.value = cat.id;
        opt.textContent = `${cat.emoji ? cat.emoji + ' ' : ''}${cat.name}`;
        if (opt.value === currentVal) opt.selected = true;
        select.appendChild(opt);
      }
    });
  });
  // Also update the "new category" parent select
  if (typeof newCatParentSelect !== 'undefined' && newCatParentSelect) {
    const cur = newCatParentSelect.value;
    newCatParentSelect.innerHTML = '';
    const noneOpt2 = document.createElement('option');
    noneOpt2.value = '';
    noneOpt2.textContent = 'No parent';
    newCatParentSelect.appendChild(noneOpt2);
    tempCats.forEach((cat) => {
      const opt2 = document.createElement('option');
      opt2.value = cat.id;
      opt2.textContent = `${cat.emoji ? cat.emoji + ' ' : ''}${cat.name}`;
      newCatParentSelect.appendChild(opt2);
    });
    if (cur) newCatParentSelect.value = cur;
  }
}

// Helper to slugify a category name to an id (lowercase, alphanumeric and hyphen)
function slugify(name) {
  return name
    .toString()
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-');
}

// Create and append a category row to the list.  Accepts an object
// { id, name, emoji, parent }.  Slug (id) may be blank; it will be
// recomputed on save.  After appending, parent select options are
// updated and the row's parent value is set to the provided parent.
function addRow(cat) {
  const row = document.createElement('div');
  row.className = 'cat-row';
  row.dataset.id = cat.id || '';
  row.style.display = 'flex';
  row.style.alignItems = 'center';
  row.style.gap = '8px';
  row.style.marginBottom = '8px';
  // Emoji input
  const emojiInput = document.createElement('input');
  emojiInput.type = 'text';
  emojiInput.className = 'emoji-input';
  emojiInput.style.width = '50px';
  emojiInput.placeholder = '😀';
  emojiInput.value = cat.emoji || '';
  // Name input
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'name-input';
  nameInput.style.flex = '1';
  nameInput.placeholder = 'Category name';
  nameInput.value = cat.name || '';
  // Parent select
  const parentSelect = document.createElement('select');
  parentSelect.className = 'parent-select';
  parentSelect.style.minWidth = '120px';
  // Delete button
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'btn secondary delete-category-btn';
  delBtn.textContent = 'Delete';
  // Append children
  row.appendChild(emojiInput);
  row.appendChild(nameInput);
  row.appendChild(parentSelect);
  row.appendChild(delBtn);
  userCategoriesListEl.appendChild(row);
  // Update parent options for all rows
  updateParentSelectOptions();
  // Set the parent value for this row (if provided)
  if (cat.parent) {
    parentSelect.value = cat.parent;
  }
}

// Add a new category using the inputs from the "Add" row
addCategoryBtn?.addEventListener('click', () => {
  const name = newCatNameInput.value.trim();
  if (!name) {
    showStatus('Category name required', 'error');
    return;
  }
  const emoji = newCatEmojiInput.value.trim() || '📁';
  const parent = newCatParentSelect.value || null;
  // Generate slug from name
  let slug = slugify(name);
  // Ensure slug is unique among existing rows
  const rows = userCategoriesListEl.querySelectorAll('.cat-row');
  const existingSlugs = new Set();
  rows.forEach((row) => {
    if (row.dataset.id) existingSlugs.add(row.dataset.id);
  });
  let base = slug;
  let counter = 1;
  while (existingSlugs.has(slug)) {
    slug = `${base}-${counter++}`;
  }
  // Create and append row
  addRow({ id: slug, name, emoji, parent });
  // Clear inputs
  newCatNameInput.value = '';
  newCatEmojiInput.value = '';
  newCatParentSelect.value = '';
  // Update parent options for all rows including new row
  updateParentSelectOptions();
});

// Delete category row (event delegation)
userCategoriesListEl?.addEventListener('click', (e) => {
  if (e.target.classList.contains('delete-category-btn')) {
    const row = e.target.closest('.cat-row');
    if (row) {
      row.remove();
      updateParentSelectOptions();
    }
  }
});

// Save categories to storage via background script
saveCategoriesBtn?.addEventListener('click', async () => {
  const rows = userCategoriesListEl.querySelectorAll('.cat-row');
  const newCats = {};
  let idx = 1;
  rows.forEach((row) => {
    const emoji = row.querySelector('.emoji-input').value.trim();
    const name = row.querySelector('.name-input').value.trim();
    const parent = row.querySelector('.parent-select').value || null;
    if (!name) return;
    let slug = row.dataset.id;
    // Always recompute slug based on name to handle renames
    slug = slugify(name);
    // Ensure unique slug by appending suffix if necessary
    let base = slug;
    let counter = 1;
    while (newCats[slug]) {
      slug = `${base}-${counter++}`;
    }
    row.dataset.id = slug;
    newCats[slug] = { id: slug, name, emoji, parent: parent || null, order: idx++ };
  });
  try {
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'updateUserCategories', userCategories: newCats }, (res) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          if (res && res.success) {
            resolve();
          } else {
            reject(new Error(res && res.error ? res.error : 'Failed'));
          }
        }
      });
    });
    showStatus('Categories saved', 'success');
    // Reload categories list from storage to reflect any adjustments
    await loadUserCategories();
  } catch (e) {
    console.error('Failed to save categories', e);
    showStatus('Error saving categories', 'error');
  }
});

saveBtn.addEventListener('click', async () => {
  try {
    // Persist classification mode and rate limit
    const mode = classificationModeSelect.value;
    const rate = parseInt(rateLimitDelayInput.value) || 2000;
    const customCats = customCategoriesInput.value.split('\n').map((c) => c.trim()).filter((c) => c.length > 0);
    await chrome.storage.local.set({ rate_limit_delay: rate, custom_categories: customCats });
    // Save classification mode via message so background reloads AI
    await chrome.runtime.sendMessage({ action: 'setClassificationMode', mode });
    // Prepare API keys to save
    const keys = {};
    const oa = openaiKeyInput.value.trim();
    const ge = geminiKeyInput.value.trim();
    const cl = claudeKeyInput.value.trim();
    const uc = uclassifyKeyInput.value.trim();
    if (oa) {
      keys.openaiApiKey = oa;
      openaiKeyInput.value = '';
      openaiKeyInput.placeholder = 'Key saved (hidden)';
    }
    if (ge) {
      keys.geminiApiKey = ge;
      geminiKeyInput.value = '';
      geminiKeyInput.placeholder = 'Key saved (hidden)';
    }
    if (cl) {
      keys.claudeApiKey = cl;
      claudeKeyInput.value = '';
      claudeKeyInput.placeholder = 'Key saved (hidden)';
    }
    if (uc) {
      keys.uclassifyApiKey = uc;
      uclassifyKeyInput.value = '';
      uclassifyKeyInput.placeholder = 'Key saved (hidden)';
    }
    if (Object.keys(keys).length > 0) {
      await chrome.runtime.sendMessage({ action: 'setApiKeys', ...keys });
    }
    showStatus('Settings saved successfully!', 'success');
  } catch (e) {
    showStatus('Error saving settings', 'error');
    console.error(e);
  }
});

resetBtn.addEventListener('click', async () => {
  if (confirm('Reset all settings to defaults?')) {
    try {
      await chrome.storage.local.clear();
      await loadSettings();
      showStatus('Settings reset', 'success');
    } catch (e) {
      showStatus('Error resetting settings', 'error');
      console.error(e);
    }
  }
});

exportBtn.addEventListener('click', async () => {
  try {
    const data = await chrome.storage.local.get();
    const exportData = { ...data, exported_at: new Date().toISOString(), version: '2.0' };
    // Do not export API keys
    delete exportData.openai_api_key;
    delete exportData.gemini_api_key;
    delete exportData.claude_api_key;
    delete exportData.uclassify_api_key;
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smart-bookmarks-settings-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showStatus('Settings exported', 'success');
  } catch (e) {
    showStatus('Error exporting', 'error');
    console.error(e);
  }
});

importBtn.addEventListener('click', () => {
  importFile.click();
});

importFile.addEventListener('change', async (evt) => {
  const file = evt.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    // Remove metadata
    delete data.exported_at;
    delete data.version;
    // Save all simple values except sensitive keys
    await chrome.storage.local.set(data);
    await loadSettings();
    showStatus('Settings imported', 'success');
  } catch (e) {
    showStatus('Error importing settings', 'error');
    console.error(e);
  }
  importFile.value = '';
});

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
  statusEl.style.display = 'block';
  setTimeout(() => {
    statusEl.style.display = 'none';
  }, 3000);
}
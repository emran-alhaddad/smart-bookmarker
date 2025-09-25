// Dashboard page logic for Smart Bookmark Organizer
//
// This script populates the dashboard with categories, lists bookmarks with
// summaries and tags, handles search and category switching, and shows
// organization progress when running.

const categoryListEl = document.getElementById('categoryList');
const bookmarkListEl = document.getElementById('bookmarkList');
const selectedCategoryEl = document.getElementById('selectedCategory');
const itemCountEl = document.getElementById('itemCount');
const catCountEl = document.getElementById('catCount');
const dashSearch = document.getElementById('dashSearch');
const dashOrganize = document.getElementById('dashOrganize');
const dashRemoveDuplicates = document.getElementById('dashRemoveDuplicates');
const dashSettings = document.getElementById('dashSettings');
const dashProgressContainer = document.getElementById('dashProgressContainer');
const dashProgressBar = document.getElementById('dashProgressBar');
const dashProgressText = document.getElementById('dashProgressText');

let dashboardData = {};
let selectedCategory = 'All';
let searchQuery = '';
let progressTimer = null;

// Listen for live progress updates from the background service.  This
// allows the dashboard to update its progress bar even if the user
// opens the page after the organization has started.  Background
// sends messages with { action: 'organizeProgress', state }.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.action === 'organizeProgress') {
    updateProgress(msg.state);
    // When done or failed, reload dashboard data and reset organize button
    if (msg.state && msg.state.status !== 'running') {
      dashOrganize.disabled = false;
      
      if (msg.state.status === 'failed') {
        dashOrganize.textContent = 'Organization Failed';
        setTimeout(() => {
          dashOrganize.textContent = 'Organize All';
        }, 5000);
      } else {
        dashOrganize.textContent = 'Organize All';
      }
      
      // Reload dashboard data
      loadDashboard();
    }
  }
});

function updateProgress(state) {
  if (!state || state.status === 'idle' || state.total === 0) {
    dashProgressContainer.style.display = 'none';
    return;
  }
  
  dashProgressContainer.style.display = 'block';
  const percentage = state.total ? Math.round((state.done / state.total) * 100) : 0;
  dashProgressBar.style.width = `${percentage}%`;
  
  if (state.status === 'failed') {
    dashProgressText.textContent = `Failed: ${state.done}/${state.total} - ${state.error || 'Unknown error'}`;
    dashProgressBar.style.background = 'linear-gradient(90deg, #ef4444, #dc2626)';
  } else if (state.status === 'done') {
    dashProgressText.textContent = `Complete: ${state.done}/${state.total}`;
    dashProgressBar.style.background = 'linear-gradient(90deg, #34d399, #10b981)';
    // Hide progress after completion
    setTimeout(() => {
      dashProgressContainer.style.display = 'none';
    }, 3000);
  } else {
    dashProgressText.textContent = `Organizing: ${state.done}/${state.total}`;
    dashProgressBar.style.background = 'linear-gradient(90deg, #34d399, #10b981)';
  }
}

function pollProgress() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(async () => {
    try {
      const state = await chrome.runtime.sendMessage({ action: 'getProgress' });
      updateProgress(state);
      
      if (!state || state.status !== 'running') {
        clearInterval(progressTimer);
        hideDashLoader();
      }
    } catch (error) {
      console.error('Failed to poll progress:', error);
      clearInterval(progressTimer);
      hideDashLoader();
    }
  }, 1000);
}

// Currently edited bookmark (for manual category assignment)
let currentEditBookmark = null;

// Show and hide the dashboard loading overlay
function showDashLoader() {
  const loader = document.getElementById('dashLoader');
  if (loader) loader.style.display = 'flex';
}
function hideDashLoader() {
  const loader = document.getElementById('dashLoader');
  if (loader) loader.style.display = 'none';
}

document.addEventListener('DOMContentLoaded', async () => {
  // Show loader and safely load dashboard data; even if it fails we continue
  showDashLoader();
  try {
    await loadDashboard();
  } catch (e) {
    console.warn('Dashboard load failed', e);
  }
  hideDashLoader();
  // On hash change (clicked from popup), select category
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash) {
    selectedCategory = hash;
    updateSelection();
  }
  dashSearch.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase();
    renderItems();
  });
  dashOrganize.addEventListener('click', async () => {
    dashOrganize.disabled = true;
    dashOrganize.textContent = 'Organizing...';
    // Show loader while organization runs
    showDashLoader();
    await chrome.runtime.sendMessage({ action: 'startOrganize' });
    pollProgress();
  });
  
  dashRemoveDuplicates.addEventListener('click', async () => {
    if (!confirm('Remove duplicate bookmarks from Smart Bookmarks folder? This will keep the oldest copy of each duplicate and remove the rest. Original bookmarks outside Smart Bookmarks will not be affected.')) {
      return;
    }
    
    dashRemoveDuplicates.disabled = true;
    dashRemoveDuplicates.textContent = 'Removing...';
    showDashLoader();
    
    try {
      const result = await chrome.runtime.sendMessage({ action: 'removeDuplicates' });
      
      if (result && result.success) {
        alert(`Successfully removed ${result.duplicatesRemoved} duplicate bookmarks!`);
        await loadDashboard();
      } else {
        alert(`Error removing duplicates: ${result.error || 'Unknown error'}`);
      }
    } catch (e) {
      alert('Error removing duplicates');
      console.error('Remove duplicates failed:', e);
    }
    
    dashRemoveDuplicates.disabled = false;
    dashRemoveDuplicates.textContent = 'Remove Duplicates';
    hideDashLoader();
  });
  
  dashSettings.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  // Edit modal buttons
  document.getElementById('editSaveBtn').addEventListener('click', saveEditBookmark);
  document.getElementById('editCancelBtn').addEventListener('click', closeEditModal);
  // Poll progress at startup
  const state = await chrome.runtime.sendMessage({ action: 'getProgress' });
  updateProgress(state);
  if (state && state.status === 'running') pollProgress();
});

async function loadDashboard() {
  // Reset dashboardData before loading to avoid stale data
  dashboardData = {};
  try {
    const res = await chrome.runtime.sendMessage({ action: 'getDashboardData' });
    dashboardData = res && res.data ? res.data : {};
    populateCategories();
    renderItems();
  } catch (e) {
    console.error('Failed to load dashboard data', e);
    // still render empty state on error
    populateCategories();
  }
}

function populateCategories() {
  categoryListEl.innerHTML = '';
  const cats = Object.keys(dashboardData).sort();
  const totalCount = cats.reduce((sum, c) => sum + (dashboardData[c].count || 0), 0);
  catCountEl.textContent = `${cats.length} categories`;
  // Empty state when no categories
  if (cats.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-hint';
    emptyDiv.textContent = 'No categories yet — try Organize to generate smart folders.';
    categoryListEl.appendChild(emptyDiv);
    bookmarkListEl.innerHTML = '';
    selectedCategoryEl.textContent = 'All';
    itemCountEl.textContent = '0 bookmarks';
    return;
  }
  // Add 'All' item
  const allLi = document.createElement('li');
  allLi.className = 'category-item' + (selectedCategory === 'All' ? ' active' : '');
  allLi.innerHTML = `<span class="category-name">All</span><span class="category-count">${totalCount}</span>`;
  allLi.addEventListener('click', () => {
    selectedCategory = 'All';
    updateSelection();
  });
  categoryListEl.appendChild(allLi);
  // Add each category
  cats.forEach((cat) => {
    const li = document.createElement('li');
    li.className = 'category-item' + (selectedCategory === cat ? ' active' : '');
    li.innerHTML = `<span class="category-name">${cat}</span><span class="category-count">${dashboardData[cat].count}</span>`;
    li.addEventListener('click', () => {
      selectedCategory = cat;
      updateSelection();
    });
    categoryListEl.appendChild(li);
  });
}

function updateSelection() {
  // Highlight selected category
  document.querySelectorAll('.category-item').forEach((li) => li.classList.remove('active'));
  const items = categoryListEl.querySelectorAll('.category-item');
  // index 0 is 'All'
  let index = selectedCategory === 'All' ? 0 : 1 + Object.keys(dashboardData).sort().indexOf(selectedCategory);
  if (index >= 0 && items[index]) items[index].classList.add('active');
  // Update header
  selectedCategoryEl.textContent = selectedCategory;
  renderItems();
}

function renderItems() {
  bookmarkListEl.innerHTML = '';
  let items = [];
  if (selectedCategory === 'All') {
    for (const cat of Object.keys(dashboardData)) {
      items = items.concat(dashboardData[cat].items);
    }
  } else {
    items = dashboardData[selectedCategory] ? dashboardData[selectedCategory].items : [];
  }
  // Filter by search
  const filtered = items.filter((it) => {
    if (!searchQuery) return true;
    const titleMatch = it.title && it.title.toLowerCase().includes(searchQuery);
    const urlMatch = it.url && it.url.toLowerCase().includes(searchQuery);
    const descMatch = it.description && it.description.toLowerCase().includes(searchQuery);
    return titleMatch || urlMatch || descMatch;
  });
  itemCountEl.textContent = `${filtered.length} bookmarks`;
  filtered.forEach((it) => {
    const div = document.createElement('div');
    div.className = 'bookmark-item';
    // Compute favicon URL via Google's favicon service
    let favUrl = '';
    try {
      favUrl = 'https://www.google.com/s2/favicons?sz=64&domain_url=' + encodeURIComponent(it.url);
    } catch {
      favUrl = '';
    }
    // Build header container
    const headerDiv = document.createElement('div');
    headerDiv.className = 'header';
    if (favUrl) {
      const img = document.createElement('img');
      img.src = favUrl;
      img.className = 'favicon';
      headerDiv.appendChild(img);
    }
    const titleDiv = document.createElement('div');
    titleDiv.className = 'title';
    titleDiv.textContent = it.title;
    headerDiv.appendChild(titleDiv);
    const catLabelDiv = document.createElement('div');
    catLabelDiv.className = 'category-label';
    if (it.primary) {
      catLabelDiv.textContent = it.primary;
    } else {
      catLabelDiv.textContent = '';
    }
    headerDiv.appendChild(catLabelDiv);
    // Actions container: holds edit and delete buttons, only visible on hover
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'actions';
    // Edit button
    const editBtn = document.createElement('button');
    editBtn.className = 'edit-btn';
    editBtn.textContent = 'Edit';
    editBtn.title = 'Edit category and tags';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditModal(it);
    });
    actionsDiv.appendChild(editBtn);
    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.textContent = 'Delete';
    delBtn.title = 'Delete bookmark';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this bookmark?')) return;
      try {
        // Remove bookmark via Chrome API
        await chrome.bookmarks.remove(it.id);
        // Remove metadata
        const metaStore = await chrome.storage.local.get(['bookmarkMeta']);
        const meta = metaStore.bookmarkMeta || {};
        delete meta[it.id];
        await chrome.storage.local.set({ bookmarkMeta: meta });
        // Reload dashboard data
        loadDashboard();
      } catch (ex) {
        console.error('Delete failed', ex);
      }
    });
    actionsDiv.appendChild(delBtn);
    headerDiv.appendChild(actionsDiv);
    div.appendChild(headerDiv);
    // URL
    const urlDiv = document.createElement('div');
    urlDiv.className = 'url';
    urlDiv.textContent = it.url;
    div.appendChild(urlDiv);
    // Description/summary
    const summaryDiv = document.createElement('div');
    summaryDiv.className = 'summary';
    summaryDiv.textContent = it.description || it.summary || '';
    div.appendChild(summaryDiv);
    // Tags
    const tagsDiv = document.createElement('div');
    tagsDiv.className = 'tags';
    (it.tags || []).forEach((t) => {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = t;
      tagsDiv.appendChild(span);
    });
    div.appendChild(tagsDiv);
    // Clicking anywhere else opens the bookmark URL
    div.addEventListener('click', () => {
      chrome.tabs.create({ url: it.url });
    });
    bookmarkListEl.appendChild(div);
  });
}

// ----- Manual edit modal logic -----

// Open the edit modal for a bookmark item
function openEditModal(item) {
  currentEditBookmark = item;
  const overlay = document.getElementById('editOverlay');
  const container = document.getElementById('editCategoriesContainer');
  const tagsInput = document.getElementById('editTagsInput');
  // Clear existing content
  container.innerHTML = '';
  // Load category definitions from storage
  chrome.storage.local.get(['userCategories'], (data) => {
    const userCategories = data.userCategories || {};
    // Sort categories by order property if available
    const catsArr = Object.values(userCategories).sort((a, b) => (a.order || 0) - (b.order || 0));
    // Build a radio list for single category selection
    const fragment = document.createElement('div');
    fragment.className = 'edit-categories';
    catsArr.forEach((cat) => {
      const row = document.createElement('div');
      row.className = 'edit-category-row';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'cat_primary';
      radio.value = cat.id;
      if (item.primary === cat.id) radio.checked = true;
      const label = document.createElement('span');
      label.textContent = `${cat.emoji ? cat.emoji + ' ' : ''}${cat.name}`;
      row.appendChild(radio);
      row.appendChild(label);
      fragment.appendChild(row);
    });
    container.appendChild(fragment);
    // Prefill tags
    tagsInput.value = (item.tags || []).join(', ');
    overlay.style.display = 'flex';
  });
}

// Close the edit modal without saving
function closeEditModal() {
  currentEditBookmark = null;
  const overlay = document.getElementById('editOverlay');
  overlay.style.display = 'none';
}

// Save changes made in the edit modal
function saveEditBookmark() {
  if (!currentEditBookmark) {
    closeEditModal();
    return;
  }
  const overlay = document.getElementById('editOverlay');
  const radioNodes = overlay.querySelectorAll('input[name="cat_primary"]');
  const tagsInput = document.getElementById('editTagsInput');
  let selectedCat = '';
  radioNodes.forEach((radio) => {
    if (radio.checked) selectedCat = radio.value;
  });
  const tagsVal = tagsInput.value;
  // If no category selected, fallback to first category (if any)
  if (!selectedCat) {
    chrome.storage.local.get(['userCategories'], (data) => {
      const keys = Object.keys(data.userCategories || {});
      selectedCat = keys.length ? keys[0] : 'other';
      finalizeSingleSave(selectedCat, tagsVal);
    });
  } else {
    finalizeSingleSave(selectedCat, tagsVal);
  }
  function finalizeSave(categories, primary) {
    // Parse tags
    const rawTags = tagsInput.value.split(',').map((s) => s.trim()).filter((s) => s.length);
    // Send message to background
    chrome.runtime.sendMessage(
      {
        action: 'updateBookmarkCategories',
        bookmarkId: currentEditBookmark.id,
        categories,
        primary,
        tags: rawTags
      },
      (res) => {
        // On success, reload dashboard data and close modal
        if (res && res.success) {
          closeEditModal();
          // Refresh dashboard data to reflect changes
          loadDashboard();
        } else {
          console.error('Failed to update bookmark categories', res);
        }
      }
    );
  }

  // Save a single category assignment (new model)
  function finalizeSingleSave(category, tagsVal) {
    const rawTags = (tagsVal || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length);
    chrome.runtime.sendMessage(
      {
        action: 'updateBookmarkMeta',
        id: currentEditBookmark.id,
        category,
        tags: rawTags
      },
      (res) => {
        if (res && res.success) {
          closeEditModal();
          loadDashboard();
        } else {
          console.error('Failed to update bookmark meta', res);
        }
      }
    );
  }
}
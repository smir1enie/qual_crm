// ===== API helpers =====
async function apiGet(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || 'Ошибка запроса');
  }
  return resp.json();
}

async function apiPost(url, data) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const result = await resp.json().catch(() => ({ error: resp.statusText }));
  if (!resp.ok) throw new Error(result.error || 'Ошибка запроса');
  return result;
}

// ===== Navigation state =====
let currentView = 'registry'; // 'registry' | 'year' | 'course' | 'participant'
let selectedYear = null;
let selectedCourse = null;
let selectedParticipant = null;
let yearsCache = null;
let allCourses = []; // full list of courses for current year

// Filter & sort state
let activeFilters = {}; // { district, org_type, position, date_from, date_to }
let sortBy = 'number';
let sortDir = 'asc';
let filterOptionsCache = null;
let courseSortBy = 'default'; // 'default' | 'name' | 'date' | 'count'
let courseSortDir = 'asc';
let isSearchMode = false; // global search active
let searchQuery = '';

// Pagination state
let currentPage = 1;
let pageSize = 10;
let allParticipants = []; // full list for current course+filters

// Report state
let reportItems = new Map(); // id -> participant data, persisted across navigation
let pageCheckedIds = new Set(); // checkboxes checked on current page view

const rowsContainer = document.getElementById('rowsContainer');
const breadcrumbs = document.querySelector('.breadcrumbs');
const searchFilterBar = document.querySelector('.search-filter-bar');
const activeFiltersBar = document.querySelector('.active-filters-bar');
const footerPaginationBar = document.querySelector('.footer-pagination-bar');
const tagsGroup = document.getElementById('tagsGroup');

// ===== Breadcrumbs =====
function updateBreadcrumbs() {
  if (!breadcrumbs) return;
  let html = '';

  if (isSearchMode) {
    const qShort = searchQuery.length > 30 ? searchQuery.slice(0, 30) + '…' : searchQuery;
    html =
      '<span class="crumb crumb--link" data-nav="registry">Реестр</span>' +
      '<svg class="chevron-right" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2l4 4-4 4" stroke="#999" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      `<span class="crumb crumb--active">Поиск: ${qShort}</span>`;
  } else if (currentView === 'registry') {
    html = '<span class="crumb crumb--active">Реестр</span>';
  } else if (currentView === 'year') {
    html =
      '<span class="crumb crumb--link" data-nav="registry">Реестр</span>' +
      '<svg class="chevron-right" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2l4 4-4 4" stroke="#999" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      `<span class="crumb crumb--active">${selectedYear}</span>`;
  } else if (currentView === 'course') {
    const courseLabel = selectedCourse && selectedCourse.length > 50
      ? selectedCourse.slice(0, 50) + '…'
      : (selectedCourse || 'Курс');
    html =
      '<span class="crumb crumb--link" data-nav="registry">Реестр</span>' +
      '<svg class="chevron-right" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2l4 4-4 4" stroke="#999" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      `<span class="crumb crumb--link" data-nav="year">${selectedYear}</span>` +
      '<svg class="chevron-right" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2l4 4-4 4" stroke="#999" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      `<span class="crumb crumb--link" data-nav="course" title="${selectedCourse || ''}">${courseLabel}</span>`;
  } else if (currentView === 'participant') {
    const courseLabel = selectedCourse && selectedCourse.length > 40
      ? selectedCourse.slice(0, 40) + '…'
      : (selectedCourse || 'Курс');
    const personLabel = selectedParticipant ? selectedParticipant.name : 'Личное дело';
    html =
      '<span class="crumb crumb--link" data-nav="registry">Реестр</span>' +
      '<svg class="chevron-right" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2l4 4-4 4" stroke="#999" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      `<span class="crumb crumb--link" data-nav="year">${selectedYear}</span>` +
      '<svg class="chevron-right" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2l4 4-4 4" stroke="#999" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      `<span class="crumb crumb--link" data-nav="course" title="${selectedCourse || ''}">${courseLabel}</span>` +
      '<svg class="chevron-right" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2l4 4-4 4" stroke="#999" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      `<span class="crumb crumb--active">${personLabel}</span>`;
  }

  breadcrumbs.innerHTML = html;

  breadcrumbs.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => {
      const target = el.getAttribute('data-nav');
      isSearchMode = false;
      searchQuery = '';
      if (searchInput) searchInput.value = '';
      if (target === 'registry') navigateTo('registry');
      else if (target === 'year') navigateTo('year');
      else if (target === 'course') navigateTo('course');
    });
  });
}

// ===== Show/hide bars per view =====
function updateBars() {
  const showCourseBars = currentView === 'course';
  const showYearBars = currentView === 'year';
  const showSearch = currentView !== 'participant';
  if (searchFilterBar) searchFilterBar.style.display = showSearch ? '' : 'none';
  if (activeFiltersBar) activeFiltersBar.style.display = (showCourseBars || showYearBars) ? '' : 'none';
  if (footerPaginationBar) footerPaginationBar.style.display = showCourseBars ? '' : 'none';
}

// ===== Active filter tags =====
function updateFilterTags() {
  if (!tagsGroup) return;
  const tags = [];
  if (activeFilters.district) tags.push({ key: 'district', label: activeFilters.district });
  if (activeFilters.org_type) tags.push({ key: 'org_type', label: activeFilters.org_type });
  if (activeFilters.position) tags.push({ key: 'position', label: activeFilters.position });
  if (activeFilters.course) tags.push({ key: 'course', label: shortenLabel(activeFilters.course) });
  if (activeFilters.date_from) tags.push({ key: 'date_from', label: 'от ' + activeFilters.date_from });
  if (activeFilters.date_to) tags.push({ key: 'date_to', label: 'до ' + activeFilters.date_to });

  let html = '<span class="tags-label">Активные фильтры:</span>';
  tags.forEach((t) => {
    html += `
      <div class="tag" data-filter-key="${t.key}">
        <span>${t.label}</span>
        <button class="tag-x" aria-label="Удалить">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 2l6 6M8 2l-6 6" stroke="#666" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      </div>`;
  });
  tagsGroup.innerHTML = html;

  tagsGroup.querySelectorAll('.tag-x').forEach((x) => {
    x.addEventListener('click', () => {
      const tag = x.closest('.tag');
      if (tag) {
        const key = tag.dataset.filterKey;
        delete activeFilters[key];
        updateFilterTags();
        if (currentView === 'course') reloadParticipants();
        else if (currentView === 'year') reloadCourses();
      }
    });
  });
}

// ===== View: Global search results =====
function renderSearchResults(results, query) {
  rowsContainer.innerHTML = '';
  rowsContainer.className = 'search-results-container';

  if (!results || results.length === 0) {
    rowsContainer.innerHTML = `<div class="empty-state">Ничего не найдено по запросу «${escapeHtml(query)}»</div>`;
    return;
  }

  // Header with count
  const header = document.createElement('div');
  header.className = 'search-results-header';
  header.innerHTML = `Найдено: <strong>${results.length}</strong> ${results.length === 1 ? 'запись' : 'записей'}`;
  rowsContainer.appendChild(header);

  results.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'search-result-card';
    card.dataset.participantId = item.id;
    card.dataset.year = item.year;
    card.dataset.course = item.course;
    card.style.cursor = 'pointer';

    // Build path: Year → Course → Person
    const courseShort = item.course && item.course.length > 50
      ? item.course.slice(0, 50) + '…'
      : (item.course || '');

    card.innerHTML = `
      <div class="search-result-avatar">${(item.name || '?').charAt(0)}</div>
      <div class="search-result-body">
        <div class="search-result-name">${highlightMatch(item.name || '', query)}</div>
        <div class="search-result-path">
          <span class="search-path-item">${item.year || ''}</span>
          <svg class="search-path-sep" width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path d="M4 2l4 4-4 4" stroke="#999" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span class="search-path-item search-path-item--course" title="${escapeHtml(item.course || '')}">${escapeHtml(courseShort)}</span>
        </div>
        <div class="search-result-meta">
          ${item.position ? `<span class="search-meta-tag">${highlightMatch(item.position, query)}</span>` : ''}
          ${item.workplace ? `<span class="search-meta-tag">${highlightMatch(item.workplace, query)}</span>` : ''}
          ${item.district ? `<span class="search-meta-tag">${highlightMatch(item.district, query)}</span>` : ''}
          ${item.org_type ? `<span class="search-meta-tag">${highlightMatch(item.org_type, query)}</span>` : ''}
        </div>
      </div>
      <svg class="search-result-arrow" width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path d="M7 5l5 5-5 5" stroke="#999" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;

    card.addEventListener('click', () => {
      selectedYear = item.year;
      selectedCourse = item.course;
      selectedParticipant = { id: item.id, name: item.name };
      navigateTo('participant');
    });

    rowsContainer.appendChild(card);
  });
}

// ===== Helpers for search highlighting =====
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

function highlightMatch(text, query) {
  if (!text || !query) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const re = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
  return escaped.replace(re, '<mark>$1</mark>');
}

// ===== View: Registry (year cards) =====
function renderRegistry(years) {
  const list = years || yearsCache || [];
  rowsContainer.innerHTML = '';
  rowsContainer.className = 'registry-cards-container';

  if (list.length === 0) {
    rowsContainer.innerHTML = '<div class="empty-state">Нет данных. Загрузите Excel файлы.</div>';
    return;
  }

  list.forEach((item) => {
    const year = item.year || item;
    const count = item.count || 0;
    const card = document.createElement('div');
    card.className = 'registry-card';
    card.innerHTML = `
      <div class="registry-card-year">${year}</div>
      <div class="registry-card-info">
        <span class="registry-card-label">записей</span>
        <span class="registry-card-count">${count}</span>
      </div>
      <svg class="registry-card-arrow" width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path d="M7 5l5 5-5 5" stroke="#999" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    card.addEventListener('click', () => {
      selectedYear = year;
      navigateTo('year');
    });
    rowsContainer.appendChild(card);
  });
}

// ===== View: Year (course cards) =====
function renderYearView(courses) {
  rowsContainer.innerHTML = '';
  rowsContainer.className = 'registry-cards-container';

  if (!courses || courses.length === 0) {
    rowsContainer.innerHTML = '<div class="empty-state">Нет курсов.</div>';
    return;
  }

  courses.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'registry-card registry-card--course';
    card.innerHTML = `
      <div class="registry-card-body">
        <div class="registry-card-course-badge"><span>Курс</span></div>
        <div class="registry-card-course-name">${item.course}</div>
        <div class="registry-card-course-meta">
          <span class="registry-card-meta-item">${item.period || ''}</span>
          <span class="registry-card-meta-sep">•</span>
          <span class="registry-card-meta-item">${item.date_start || ''} — ${item.date_end || ''}</span>
          <span class="registry-card-meta-sep">•</span>
          <span class="registry-card-meta-item">${item.count} слушателей</span>
        </div>
      </div>
      <svg class="registry-card-arrow" width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path d="M7 5l5 5-5 5" stroke="#999" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    card.addEventListener('click', () => {
      selectedCourse = item.course;
      navigateTo('course');
    });
    rowsContainer.appendChild(card);
  });
}

// ===== View: Course (participant rows with pagination) =====
function renderRows(data) {
  rowsContainer.innerHTML = '';
  rowsContainer.className = 'product-rows-container';

  if (!data || data.length === 0) {
    rowsContainer.innerHTML = '<div class="empty-state">Нет слушателей.</div>';
    renderPagination(0);
    return;
  }

  // Paginate
  const totalPages = Math.ceil(data.length / pageSize);
  if (currentPage > totalPages) currentPage = 1;
  const start = (currentPage - 1) * pageSize;
  const pageData = data.slice(start, start + pageSize);

  pageData.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'product-row';
    row.dataset.participantId = item.id;
    row.style.cursor = 'pointer';
    row.innerHTML = `
      <div class="number-col"><span>${item.number || ''}</span></div>
      <div class="product-info-grid">
        <div class="row-header">
          <div class="row-name-block">
            <span class="row-year">${item.year || ''}</span>
            <span class="row-name">${item.name || ''}</span>
          </div>
          <div class="row-course-block">
            <span class="row-course-label">Курс</span>
            <div class="row-course-badge"><span>${item.course || ''}</span></div>
          </div>
        </div>
        <div class="row-separator"></div>
        <div class="data-row">
          <div class="data-group data-group--fixed">
            <div class="data-cell data-cell--fixed">
              <span class="data-label">район</span>
              <span class="data-value"><span class="data-value-dot"></span>${item.district || ''}</span>
            </div>
            <div class="data-cell data-cell--fixed">
              <span class="data-label">СРОКИ</span>
              <span class="data-value">${item.period || ''}</span>
            </div>
            <div class="data-cell data-cell--fixed">
              <span class="data-label">Дата начала курса</span>
              <span class="data-value">${item.date_start || ''}</span>
            </div>
            <div class="data-cell data-cell--fixed">
              <span class="data-label">Дата окончания курса</span>
              <span class="data-value">${item.date_end || ''}</span>
            </div>
          </div>
          <div class="data-group data-group--flex">
            <div class="data-cell data-cell--flex">
              <span class="data-label">Тип ОУ</span>
              <span class="data-value data-value--regular">${item.org_type || ''}</span>
            </div>
            <div class="data-cell data-cell--flex">
              <span class="data-label">Должность слушателя</span>
              <span class="data-value data-value--regular">${item.position || ''}</span>
            </div>
          </div>
        </div>
        <div class="data-row data-row--second">
          <div class="data-cell" style="flex:1">
            <span class="data-label">Место работы слушателя</span>
            <span class="data-value"><span class="data-value-dot"></span>${item.workplace || ''}</span>
          </div>
        </div>
      </div>
      <div class="checkbox-col">
        <div class="checkbox" role="checkbox" aria-checked="false" tabindex="0">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M1.5 5l2.5 2.5L8.5 2" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
      </div>
    `;
    rowsContainer.appendChild(row);
  });
  bindCheckboxes();
  bindRowClicks();
  renderPagination(data.length);
}

// ===== Pagination rendering =====
function renderPagination(totalItems) {
  const pagesGroup = document.getElementById('pagesGroup');
  if (!pagesGroup) return;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  let html = '';
  html += `<button class="page-btn page-btn--nav" data-page="prev" ${currentPage === 1 ? 'disabled' : ''}>
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8 2L4 6l4 4" stroke="#666" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>`;

  // Show up to 5 page buttons
  let startPage = Math.max(1, currentPage - 2);
  let endPage = Math.min(totalPages, startPage + 4);
  if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);

  for (let i = startPage; i <= endPage; i++) {
    html += `<button class="page-btn ${i === currentPage ? 'page-btn--active' : ''}" data-page="${i}">${i}</button>`;
  }

  html += `<button class="page-btn page-btn--nav" data-page="next" ${currentPage === totalPages ? 'disabled' : ''}>
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2l4 4-4 4" stroke="#666" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>`;

  pagesGroup.innerHTML = html;

  pagesGroup.querySelectorAll('.page-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      if (page === 'prev') currentPage = Math.max(1, currentPage - 1);
      else if (page === 'next') currentPage = Math.min(totalPages, currentPage + 1);
      else currentPage = parseInt(page);
      renderRows(allParticipants);
    });
  });
}

// ===== Row click -> open personal dossier =====
function bindRowClicks() {
  document.querySelectorAll('.product-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.checkbox-col')) return;
      const id = row.dataset.participantId;
      if (id) {
        selectedParticipant = { id: parseInt(id), name: row.querySelector('.row-name')?.textContent || '' };
        navigateTo('participant');
      }
    });
  });
}

// ===== View: Participant (personal dossier) =====
function renderParticipant(person) {
  rowsContainer.innerHTML = '';
  rowsContainer.className = 'participant-dossier-container';

  if (!person || person.error) {
    rowsContainer.innerHTML = '<div class="empty-state">Запись не найдена.</div>';
    return;
  }

  selectedParticipant = person;

  const historyHtml = (person.history || []).map((h) => `
    <div class="history-item">
      <div class="history-item-year">${h.year}</div>
      <div class="history-item-body">
        <div class="history-item-course">${h.course || ''}</div>
        <div class="history-item-meta">
          <span>${h.period || ''}</span>
          <span class="registry-card-meta-sep">•</span>
          <span>${h.date_start || ''} — ${h.date_end || ''}</span>
          <span class="registry-card-meta-sep">•</span>
          <span>${h.position || ''}</span>
        </div>
      </div>
    </div>
  `).join('');

  const card = document.createElement('div');
  card.className = 'participant-dossier';
  card.innerHTML = `
    <div class="dossier-header">
      <div class="dossier-avatar">${(person.name || '?').charAt(0)}</div>
      <div class="dossier-title">
        <div class="dossier-name">${person.name || ''}</div>
        <div class="dossier-year">Год: ${person.year || ''}</div>
      </div>
    </div>
    <div class="dossier-section">
      <div class="dossier-section-title">Основная информация</div>
      <div class="dossier-grid">
        <div class="dossier-field">
          <span class="dossier-field-label">Курс</span>
          <span class="dossier-field-value">${person.course || ''}</span>
        </div>
        <div class="dossier-field">
          <span class="dossier-field-label">Должность</span>
          <span class="dossier-field-value">${person.position || ''}</span>
        </div>
        <div class="dossier-field">
          <span class="dossier-field-label">Место работы</span>
          <span class="dossier-field-value">${person.workplace || ''}</span>
        </div>
        <div class="dossier-field">
          <span class="dossier-field-label">Район</span>
          <span class="dossier-field-value">${person.district || ''}</span>
        </div>
        <div class="dossier-field">
          <span class="dossier-field-label">Тип ОУ</span>
          <span class="dossier-field-value">${person.org_type || ''}</span>
        </div>
        <div class="dossier-field">
          <span class="dossier-field-label">Сроки обучения</span>
          <span class="dossier-field-value">${person.period || ''}</span>
        </div>
        <div class="dossier-field">
          <span class="dossier-field-label">Дата начала курса</span>
          <span class="dossier-field-value">${person.date_start || ''}</span>
        </div>
        <div class="dossier-field">
          <span class="dossier-field-label">Дата окончания курса</span>
          <span class="dossier-field-value">${person.date_end || ''}</span>
        </div>
      </div>
    </div>
    ${person.history && person.history.length > 0 ? `
      <div class="dossier-section">
        <div class="dossier-section-title">История обучения (${person.history.length})</div>
        <div class="dossier-history">
          ${historyHtml}
        </div>
      </div>
    ` : ''}
  `;
  rowsContainer.appendChild(card);
}

// ===== Reload courses with current sort/filters (year view) =====
function sortAndFilterCourses(courses) {
  let list = [...courses];

  // Filter by date range
  if (activeFilters.date_from) {
    list = list.filter((c) => (c.date_start || '') >= activeFilters.date_from);
  }
  if (activeFilters.date_to) {
    list = list.filter((c) => (c.date_end || '') <= activeFilters.date_to);
  }

  // Sort
  if (courseSortBy === 'name') {
    list.sort((a, b) => courseSortDir === 'desc'
      ? (b.course || '').localeCompare(a.course || '')
      : (a.course || '').localeCompare(b.course || ''));
  } else if (courseSortBy === 'date') {
    list.sort((a, b) => courseSortDir === 'desc'
      ? (b.date_start || '').localeCompare(a.date_start || '')
      : (a.date_start || '').localeCompare(b.date_start || ''));
  } else if (courseSortBy === 'count') {
    list.sort((a, b) => courseSortDir === 'desc'
      ? (b.count || 0) - (a.count || 0)
      : (a.count || 0) - (b.count || 0));
  }

  return list;
}

async function reloadCourses() {
  if (currentView !== 'year') return;
  let url = `/api/courses?year=${selectedYear}`;
  if (activeFilters.district) url += `&district=${encodeURIComponent(activeFilters.district)}`;
  if (activeFilters.org_type) url += `&org_type=${encodeURIComponent(activeFilters.org_type)}`;
  if (activeFilters.position) url += `&position=${encodeURIComponent(activeFilters.position)}`;
  if (activeFilters.course) url += `&course=${encodeURIComponent(activeFilters.course)}`;
  if (activeFilters.date_from) url += `&date_from=${encodeURIComponent(activeFilters.date_from)}`;
  if (activeFilters.date_to) url += `&date_to=${encodeURIComponent(activeFilters.date_to)}`;
  try {
    allCourses = await apiGet(url);
  } catch (e) {
    allCourses = [];
  }
  const processed = sortAndFilterCourses(allCourses);
  renderYearView(processed);
  updateFilterTags();
}

// ===== Reload participants with current filters/sort =====
async function reloadParticipants() {
  if (currentView !== 'course') return;
  currentPage = 1;
  let url = `/api/participants?year=${selectedYear}&course=${encodeURIComponent(selectedCourse)}`;
  const hasFilters = Object.keys(activeFilters).length > 0;
  if (activeFilters.district) url += `&district=${encodeURIComponent(activeFilters.district)}`;
  if (activeFilters.org_type) url += `&org_type=${encodeURIComponent(activeFilters.org_type)}`;
  if (activeFilters.position) url += `&position=${encodeURIComponent(activeFilters.position)}`;
  if (activeFilters.date_from) url += `&date_from=${encodeURIComponent(activeFilters.date_from)}`;
  if (activeFilters.date_to) url += `&date_to=${encodeURIComponent(activeFilters.date_to)}`;
  if (sortBy !== 'number' || sortDir !== 'asc') url += `&sort=${sortBy}&dir=${sortDir}`;
  try {
    allParticipants = await apiGet(url);
    renderRows(allParticipants);
  } catch (e) {
    allParticipants = [];
    renderRows([]);
  }
  updateFilterTags();
}

// ===== Navigation router (async) =====
async function navigateTo(view) {
  currentView = view;
  isSearchMode = false;
  searchQuery = '';
  if (searchInput) searchInput.value = '';
  // Reset page selection when navigating
  pageCheckedIds.clear();
  updateSelectionBar();

  if (view === 'registry') {
    selectedYear = null;
    selectedCourse = null;
    activeFilters = {};
    try {
      yearsCache = await apiGet('/api/years');
    } catch (e) {
      yearsCache = [];
    }
    renderRegistry();
  } else if (view === 'year') {
    selectedCourse = null;
    activeFilters = {};
    courseSortBy = 'default';
    courseSortDir = 'asc';
    if (filterDropdown) filterDropdown.querySelector('.dropdown-value').textContent = 'Все';
    await reloadCourses();
  } else if (view === 'course') {
    currentPage = 1;
    await reloadParticipants();
  } else if (view === 'participant') {
    if (selectedParticipant && selectedParticipant.id) {
      try {
        const person = await apiGet(`/api/participant/${selectedParticipant.id}`);
        renderParticipant(person);
      } catch (e) {
        renderParticipant(null);
      }
    } else {
      renderParticipant(null);
    }
  }
  updateBreadcrumbs();
  updateBars();
}

// ===== Checkbox interactions =====
function bindCheckboxes() {
  document.querySelectorAll('.checkbox').forEach((cb) => {
    // Restore checked state from pageCheckedIds
    const row = cb.closest('.product-row');
    const pid = row ? row.dataset.participantId : null;
    if (pid && pageCheckedIds.has(String(pid))) {
      cb.classList.add('checked');
      cb.setAttribute('aria-checked', 'true');
      if (row) row.classList.add('selected');
    }
    const toggle = () => {
      cb.classList.toggle('checked');
      const isChecked = cb.classList.contains('checked');
      cb.setAttribute('aria-checked', isChecked);
      if (row) row.classList.toggle('selected', isChecked);
      if (pid) {
        if (isChecked) pageCheckedIds.add(String(pid));
        else pageCheckedIds.delete(String(pid));
      }
      updateSelectionBar();
    };
    cb.addEventListener('click', toggle);
    cb.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        toggle();
      }
    });
  });
  updateSelectionBar();
}

// ===== Selection bar =====
const selectionBar = document.getElementById('selectionBar');
const selectionBarCount = document.getElementById('selectionBarCount');
const selectionClearBtn = document.getElementById('selectionClearBtn');
const selectionAddReportBtn = document.getElementById('selectionAddReportBtn');
const addReportBadge = document.getElementById('addReportBadge');
const navReportBadge = document.getElementById('navReportBadge');

function updateReportBadges() {
  const count = reportItems.size;
  if (navReportBadge) {
    if (count > 0) {
      navReportBadge.textContent = count > 99 ? '99+' : count;
      navReportBadge.style.display = '';
    } else {
      navReportBadge.style.display = 'none';
    }
  }
  if (addReportBadge) {
    if (count > 0) {
      addReportBadge.textContent = count > 99 ? '99+' : count;
      addReportBadge.style.display = '';
    } else {
      addReportBadge.style.display = 'none';
    }
  }
}

function updateSelectionBar() {
  const count = pageCheckedIds.size;
  if (count > 0) {
    if (selectionBar) selectionBar.style.display = '';
    if (selectionBarCount) selectionBarCount.textContent = count;
  } else {
    if (selectionBar) selectionBar.style.display = 'none';
  }
  updateReportBadges();
}

function clearPageSelection() {
  pageCheckedIds.clear();
  document.querySelectorAll('.checkbox.checked').forEach((cb) => {
    cb.classList.remove('checked');
    cb.setAttribute('aria-checked', 'false');
    const row = cb.closest('.product-row');
    if (row) row.classList.remove('selected');
  });
  updateSelectionBar();
}

if (selectionClearBtn) {
  selectionClearBtn.addEventListener('click', clearPageSelection);
}

if (selectionAddReportBtn) {
  selectionAddReportBtn.addEventListener('click', () => {
    const pageData = getPageData();
    let added = 0;
    pageCheckedIds.forEach((pid) => {
      const item = pageData.find((p) => String(p.id) === pid);
      if (item && !reportItems.has(String(item.id))) {
        reportItems.set(String(item.id), item);
        added++;
      }
    });
    if (added > 0) {
      const total = reportItems.size;
      selectionAddReportBtn.classList.add('flash');
      setTimeout(() => selectionAddReportBtn.classList.remove('flash'), 600);
      showToast(`Добавлено в отчёт: ${added}. Всего в отчёте: ${total}`);
    } else {
      showToast('Все выбранные уже в отчёте');
    }
    clearPageSelection();
  });
}

function getPageData() {
  if (currentView === 'course' && allParticipants.length > 0) {
    const start = (currentPage - 1) * pageSize;
    return allParticipants.slice(start, start + pageSize);
  }
  const items = [];
  document.querySelectorAll('.product-row[data-participant-id]').forEach((row) => {
    items.push({
      id: row.dataset.participantId,
      name: row.querySelector('.row-name')?.textContent?.trim() || '',
      year: row.querySelector('.row-year')?.textContent?.trim() || '',
      course: row.querySelector('.row-course-badge span')?.textContent?.trim() || '',
      workplace: row.querySelector('[class*="data-value"]')?.textContent?.trim() || '',
    });
  });
  return items;
}

// ===== Toast =====
let toastTimer = null;
function showToast(msg) {
  let toast = document.getElementById('devinToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'devinToast';
    toast.className = 'devin-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

// ===== Search =====
const searchInput = document.getElementById('searchInput');
if (searchInput) {
  let searchTimer = null;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();

    if (currentView === 'registry' || currentView === 'year') {
      if (!q) {
        isSearchMode = false;
        searchQuery = '';
        updateBreadcrumbs();
        if (currentView === 'registry') renderRegistry();
        else if (currentView === 'year') reloadCourses();
        return;
      }
      searchTimer = setTimeout(async () => {
        isSearchMode = true;
        searchQuery = q;
        updateBreadcrumbs();
        try {
          const results = await apiGet(`/api/search?q=${encodeURIComponent(q)}`);
          renderSearchResults(results, q);
        } catch (err) {
          renderSearchResults([], q);
        }
      }, 300);
      return;
    }

    if (currentView === 'course') {
      searchTimer = setTimeout(async () => {
        currentPage = 1;
        let url = `/api/participants?year=${selectedYear}&course=${encodeURIComponent(selectedCourse)}`;
        if (q) url += `&q=${encodeURIComponent(q)}`;
        if (activeFilters.district) url += `&district=${encodeURIComponent(activeFilters.district)}`;
        if (activeFilters.org_type) url += `&org_type=${encodeURIComponent(activeFilters.org_type)}`;
        if (activeFilters.position) url += `&position=${encodeURIComponent(activeFilters.position)}`;
        if (activeFilters.date_from) url += `&date_from=${encodeURIComponent(activeFilters.date_from)}`;
        if (activeFilters.date_to) url += `&date_to=${encodeURIComponent(activeFilters.date_to)}`;
        if (sortBy !== 'number' || sortDir !== 'asc') url += `&sort=${sortBy}&dir=${sortDir}`;
        try {
          allParticipants = await apiGet(url);
          renderRows(allParticipants);
        } catch (err) {
          allParticipants = [];
          renderRows([]);
        }
      }, 300);
    }
  });
}

// ===== Clear filters =====
const clearBtn = document.getElementById('clearFiltersBtn');
if (clearBtn) {
  clearBtn.addEventListener('click', () => {
    activeFilters = {};
    isSearchMode = false;
    searchQuery = '';
    if (searchInput) searchInput.value = '';
    updateFilterTags();
    updateBreadcrumbs();
    if (currentView === 'course') reloadParticipants();
    else if (currentView === 'year') reloadCourses();
    else if (currentView === 'registry') renderRegistry();
  });
}

// ===== Dropdown menus =====
const dropdownMenu = document.getElementById('dropdownMenu');
let openDropdown = null;

function showDropdownMenu(target, items, onSelect) {
  if (openDropdown === target) {
    hideDropdownMenu();
    return;
  }
  hideDropdownMenu();

  let html = '';
  items.forEach((item) => {
    if (item.value === '__header__') {
      html += `<div class="dropdown-menu-header">${item.label}</div>`;
    } else {
      html += `<div class="dropdown-menu-item" data-value="${item.value}" title="${escapeHtml(item.label)}">${item.label}</div>`;
    }
  });
  dropdownMenu.innerHTML = html;
  dropdownMenu.style.display = 'block';
  dropdownMenu.style.visibility = 'hidden';

  const rect = target.getBoundingClientRect();
  const menuHeight = Math.min(dropdownMenu.scrollHeight + 8, 420);
  const spaceBelow = window.innerHeight - rect.bottom - 8;
  const spaceAbove = rect.top - 8;

  // Open upward if not enough space below and more space above
  if (spaceBelow < 200 && spaceAbove > spaceBelow) {
    dropdownMenu.style.top = (rect.top + window.scrollY - menuHeight - 4) + 'px';
  } else {
    dropdownMenu.style.top = (rect.bottom + window.scrollY + 4) + 'px';
  }
  dropdownMenu.style.maxHeight = Math.min(420, Math.max(spaceBelow, spaceAbove) - 8) + 'px';
  dropdownMenu.style.left = (rect.left + window.scrollX) + 'px';
  dropdownMenu.style.minWidth = Math.max(rect.width, 260) + 'px';
  dropdownMenu.style.visibility = '';

  dropdownMenu.querySelectorAll('.dropdown-menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      const value = el.dataset.value;
      const label = el.textContent;
      onSelect(value, label);
      hideDropdownMenu();
    });
  });

  openDropdown = target;
}

function hideDropdownMenu() {
  if (dropdownMenu) dropdownMenu.style.display = 'none';
  openDropdown = null;
}

document.addEventListener('click', (e) => {
  if (openDropdown && !openDropdown.contains(e.target) && !dropdownMenu.contains(e.target)) {
    hideDropdownMenu();
  }
});

// "Выбор" dropdown — direct filter by field value
const filterDropdown = document.getElementById('filterDropdown');
if (filterDropdown) {
  filterDropdown.addEventListener('click', async (e) => {
    e.stopPropagation();

    // Load filter options on demand
    if (!filterOptionsCache || filterOptionsCache._year !== selectedYear) {
      try {
        filterOptionsCache = await apiGet(`/api/filter-options?year=${selectedYear || ''}`);
        filterOptionsCache._year = selectedYear;
      } catch (err) {
        filterOptionsCache = { districts: [], org_types: [], positions: [], courses: [] };
      }
    }

    let items = [{ value: 'all', label: 'Все (сбросить)' }];

    // Both year and course views show district/org_type/position filters
    if (filterOptionsCache.districts.length > 0) {
      items.push({ value: '__header__', label: '— Район —' });
      filterOptionsCache.districts.forEach((d) => {
        items.push({ value: 'district:' + d, label: d });
      });
    }
    if (filterOptionsCache.org_types.length > 0) {
      items.push({ value: '__header__', label: '— Тип ОУ —' });
      filterOptionsCache.org_types.forEach((t) => {
        items.push({ value: 'org_type:' + t, label: t });
      });
    }
    if (filterOptionsCache.positions.length > 0) {
      items.push({ value: '__header__', label: '— Должность —' });
      filterOptionsCache.positions.forEach((p) => {
        items.push({ value: 'position:' + p, label: p });
      });
    }
    // Course filter only on year view (list of course cards)
    if (currentView === 'year' && filterOptionsCache.courses && filterOptionsCache.courses.length > 0) {
      items.push({ value: '__header__', label: '— Курс —' });
      filterOptionsCache.courses.forEach((c) => {
        items.push({ value: 'course:' + c, label: shortenLabel(c) });
      });
    }

    showDropdownMenu(filterDropdown, items, (value, label) => {
      if (value === 'all') {
        activeFilters = {};
        filterDropdown.querySelector('.dropdown-value').textContent = 'Все';
        updateFilterTags();
        if (currentView === 'course') reloadParticipants();
        else if (currentView === 'year') reloadCourses();
      } else if (value === 'date_from') {
        openFiltersModal('date_from');
      } else if (value !== '__header__') {
        const [field, ...rest] = value.split(':');
        const val = rest.join(':');
        activeFilters[field] = val;
        filterDropdown.querySelector('.dropdown-value').textContent = label.length > 20 ? label.slice(0, 20) + '…' : label;
        updateFilterTags();
        if (currentView === 'course') reloadParticipants();
        else if (currentView === 'year') reloadCourses();
      }
    });
  });
}

// "Сортировка" dropdown
const sortDropdown = document.getElementById('sortDropdown');
if (sortDropdown) {
  sortDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
    let items;
    if (currentView === 'year') {
      items = [
        { value: 'default:asc', label: 'По умолчанию' },
        { value: 'name:asc', label: 'По названию (А→Я)' },
        { value: 'name:desc', label: 'По названию (Я→А)' },
        { value: 'date:asc', label: 'По дате (возр.)' },
        { value: 'date:desc', label: 'По дате (убыв.)' },
        { value: 'count:desc', label: 'По количеству (убыв.)' },
        { value: 'count:asc', label: 'По количеству (возр.)' },
      ];
    } else {
      items = [
        { value: 'number:asc', label: 'По умолчанию' },
        { value: 'name:asc', label: 'По имени (А→Я)' },
        { value: 'name:desc', label: 'По имени (Я→А)' },
        { value: 'date:asc', label: 'По дате (возр.)' },
        { value: 'date:desc', label: 'По дате (убыв.)' },
        { value: 'district:asc', label: 'По району' },
        { value: 'position:asc', label: 'По должности' },
      ];
    }
    showDropdownMenu(sortDropdown, items, (value, label) => {
      sortDropdown.querySelector('.dropdown-value').textContent = label;
      const [field, dir] = value.split(':');
      if (currentView === 'year') {
        courseSortBy = field;
        courseSortDir = dir;
        const processed = sortAndFilterCourses(allCourses);
        renderYearView(processed);
      } else {
        sortBy = field;
        sortDir = dir;
        reloadParticipants();
      }
    });
  });
}

// Page size dropdown
const pageSizeDropdown = document.getElementById('pageSizeDropdown');
const pageSizeValue = document.getElementById('pageSizeValue');
if (pageSizeDropdown) {
  pageSizeDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
    const items = [
      { value: '10', label: '10' },
      { value: '25', label: '25' },
      { value: '50', label: '50' },
      { value: '100', label: '100' },
    ];
    showDropdownMenu(pageSizeDropdown, items, (value, label) => {
      pageSize = parseInt(value);
      if (pageSizeValue) pageSizeValue.textContent = label;
      currentPage = 1;
      renderRows(allParticipants);
    });
  });
}

// ===== Advanced Filters Modal =====
const filtersModal = document.getElementById('filtersModal');
const advancedFiltersBtn = document.getElementById('advancedFiltersBtn');
const filtersCloseBtn = document.getElementById('filtersCloseBtn');
const filtersApplyBtn = document.getElementById('filtersApplyBtn');
const filtersResetBtn = document.getElementById('filtersResetBtn');

async function openFiltersModal(focusField) {
  if (!filtersModal) return;

  // Load filter options
  if (!filterOptionsCache) {
    try {
      filterOptionsCache = await apiGet(`/api/filter-options?year=${selectedYear || ''}`);
    } catch (e) {
      filterOptionsCache = { districts: [], org_types: [], positions: [], courses: [] };
    }
  }

  const opts = filterOptionsCache;
  const districtSelect = document.getElementById('filterDistrict');
  const orgTypeSelect = document.getElementById('filterOrgType');
  const positionSelect = document.getElementById('filterPosition');
  const courseInput = document.getElementById('filterCourse');

  districtSelect.innerHTML = '<option value="">Все районы</option>' +
    opts.districts.map((d) => `<option value="${d}" ${activeFilters.district === d ? 'selected' : ''}>${d}</option>`).join('');
  orgTypeSelect.innerHTML = '<option value="">Все типы</option>' +
    opts.org_types.map((t) => `<option value="${t}" ${activeFilters.org_type === t ? 'selected' : ''}>${t}</option>`).join('');
  positionSelect.innerHTML = '<option value="">Все должности</option>' +
    opts.positions.map((p) => `<option value="${p}" ${activeFilters.position === p ? 'selected' : ''}>${p}</option>`).join('');
  if (courseInput) {
    courseInput.value = activeFilters.course || '';
    hideCourseSuggestions();
  }

  document.getElementById('filterDateFrom').value = activeFilters.date_from || '';
  document.getElementById('filterDateTo').value = activeFilters.date_to || '';

  filtersModal.style.display = 'flex';

  if (focusField === 'district') districtSelect.focus();
  else if (focusField === 'org_type') orgTypeSelect.focus();
  else if (focusField === 'position') positionSelect.focus();
  else if (focusField === 'course' && courseInput) courseInput.focus();
}

if (advancedFiltersBtn) {
  advancedFiltersBtn.addEventListener('click', () => openFiltersModal());
}
if (filtersCloseBtn) {
  filtersCloseBtn.addEventListener('click', () => { filtersModal.style.display = 'none'; });
}
if (filtersResetBtn) {
  filtersResetBtn.addEventListener('click', () => {
    activeFilters = {};
    document.getElementById('filterDistrict').value = '';
    document.getElementById('filterOrgType').value = '';
    document.getElementById('filterPosition').value = '';
    document.getElementById('filterCourse').value = '';
    document.getElementById('filterDateFrom').value = '';
    document.getElementById('filterDateTo').value = '';
    updateFilterTags();
    if (currentView === 'course') reloadParticipants();
    else if (currentView === 'year') reloadCourses();
    filtersModal.style.display = 'none';
  });
}
if (filtersApplyBtn) {
  filtersApplyBtn.addEventListener('click', () => {
    activeFilters.district = document.getElementById('filterDistrict').value || '';
    activeFilters.org_type = document.getElementById('filterOrgType').value || '';
    activeFilters.position = document.getElementById('filterPosition').value || '';
    activeFilters.course = document.getElementById('filterCourse').value || '';
    activeFilters.date_from = document.getElementById('filterDateFrom').value || '';
    activeFilters.date_to = document.getElementById('filterDateTo').value || '';
    // Remove empty values
    Object.keys(activeFilters).forEach((k) => { if (!activeFilters[k]) delete activeFilters[k]; });
    updateFilterTags();
    if (currentView === 'course') reloadParticipants();
    else if (currentView === 'year') reloadCourses();
    filtersModal.style.display = 'none';
  });
}

// Close modal on overlay click
if (filtersModal) {
  filtersModal.addEventListener('click', (e) => {
    if (e.target === filtersModal) filtersModal.style.display = 'none';
  });
}

// ===== Course autocomplete =====
const filterCourseInput = document.getElementById('filterCourse');
const filterCourseList = document.getElementById('filterCourseList');

function hideCourseSuggestions() {
  if (filterCourseList) filterCourseList.style.display = 'none';
}

function matchCourses(q) {
  const courses = (filterOptionsCache && filterOptionsCache.courses) || [];
  if (!q) return courses;
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  return courses.filter((c) => {
    const lower = c.toLowerCase();
    return tokens.every((t) => lower.includes(t));
  });
}

function renderCourseSuggestions(matches) {
  if (!filterCourseList) return;
  if (matches.length === 0) {
    filterCourseList.innerHTML = '<div class="autocomplete-empty">Ничего не найдено</div>';
    filterCourseList.style.display = '';
    return;
  }
  filterCourseList.innerHTML = matches.map((c) =>
    `<div class="autocomplete-item" data-value="${escapeHtml(c)}" title="${escapeHtml(c)}">${escapeHtml(c)}</div>`
  ).join('');
  filterCourseList.style.display = '';
  filterCourseList.querySelectorAll('.autocomplete-item').forEach((el) => {
    el.addEventListener('click', () => {
      filterCourseInput.value = el.dataset.value;
      hideCourseSuggestions();
    });
  });
}

if (filterCourseInput) {
  filterCourseInput.addEventListener('input', () => {
    renderCourseSuggestions(matchCourses(filterCourseInput.value.trim()));
  });
  filterCourseInput.addEventListener('focus', () => {
    renderCourseSuggestions(matchCourses(filterCourseInput.value.trim()));
  });
  filterCourseInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideCourseSuggestions();
  });
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.autocomplete-wrap')) hideCourseSuggestions();
});

// ===== Add Record Modal =====
const addModal = document.getElementById('addModal');
const addRecordBtn = document.getElementById('addRecordBtn');
const addRecordBtnBottom = document.getElementById('addRecordBtnBottom');
const addCloseBtn = document.getElementById('addCloseBtn');
const addCancelBtn = document.getElementById('addCancelBtn');
const addSaveBtn = document.getElementById('addSaveBtn');

function openAddModal() {
  if (!addModal) return;
  // Pre-fill year if selected
  document.getElementById('addYear').value = selectedYear || '';
  document.getElementById('addName').value = '';
  document.getElementById('addCourse').value = selectedCourse || '';
  document.getElementById('addWorkplace').value = '';
  document.getElementById('addPosition').value = '';
  document.getElementById('addDistrict').value = '';
  document.getElementById('addDateStart').value = '';
  document.getElementById('addDateEnd').value = '';
  document.getElementById('addPeriod').value = '';
  document.getElementById('addOrgType').value = '';
  addModal.style.display = 'flex';
}

// ===== Add button dropdown =====
function toggleAddDropdown(menuId, btn) {
  const menu = document.getElementById(menuId);
  if (!menu) return;
  const isOpen = menu.classList.contains('add-dropdown-menu--open');
  // Close all other add dropdowns
  document.querySelectorAll('.add-dropdown-menu').forEach((m) => m.classList.remove('add-dropdown-menu--open'));
  if (!isOpen) menu.classList.add('add-dropdown-menu--open');
}

if (addRecordBtn) {
  addRecordBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAddDropdown('addDropdownMenuTop', addRecordBtn);
  });
}
if (addRecordBtnBottom) {
  addRecordBtnBottom.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAddDropdown('addDropdownMenuBottom', addRecordBtnBottom);
  });
}

// Close add dropdown on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.add-dropdown')) {
    document.querySelectorAll('.add-dropdown-menu').forEach((m) => m.classList.remove('add-dropdown-menu--open'));
  }
});

// Handle add dropdown item clicks
document.querySelectorAll('.add-dropdown-item').forEach((item) => {
  item.addEventListener('click', () => {
    const action = item.dataset.addAction;
    // Close all dropdowns
    document.querySelectorAll('.add-dropdown-menu').forEach((m) => m.classList.remove('add-dropdown-menu--open'));
    if (action === 'record') {
      openAddModal();
    } else if (action === 'excel') {
      openExcelModal();
    }
  });
});
if (addCloseBtn) addCloseBtn.addEventListener('click', () => { addModal.style.display = 'none'; });
if (addCancelBtn) addCancelBtn.addEventListener('click', () => { addModal.style.display = 'none'; });

if (addSaveBtn) {
  addSaveBtn.addEventListener('click', async () => {
    const name = document.getElementById('addName').value.trim();
    const year = document.getElementById('addYear').value.trim();
    const course = document.getElementById('addCourse').value.trim();

    if (!name || !year || !course) {
      alert('Заполните обязательные поля: ФИО, Год, Курс');
      return;
    }

    const data = {
      name,
      year: parseInt(year),
      course,
      workplace: document.getElementById('addWorkplace').value.trim(),
      position: document.getElementById('addPosition').value.trim(),
      district: document.getElementById('addDistrict').value.trim(),
      date_start: document.getElementById('addDateStart').value.trim(),
      date_end: document.getElementById('addDateEnd').value.trim(),
      period: document.getElementById('addPeriod').value.trim(),
      org_type: document.getElementById('addOrgType').value.trim(),
    };

    try {
      await apiPost('/api/participant', data);
      addModal.style.display = 'none';
      // Reload data
      if (currentView === 'course') {
        reloadParticipants();
      } else if (currentView === 'year') {
        navigateTo('year');
      } else {
        navigateTo('registry');
      }
    } catch (e) {
      alert('Ошибка: ' + e.message);
    }
  });
}

if (addModal) {
  addModal.addEventListener('click', (e) => {
    if (e.target === addModal) addModal.style.display = 'none';
  });
}

// ===== Excel Upload =====
const excelModal = document.getElementById('excelModal');
const excelFileInput = document.getElementById('excelFileInput');
const excelDropZone = document.getElementById('excelDropZone');
const excelProgress = document.getElementById('excelProgress');
const excelProgressFill = document.getElementById('excelProgressFill');
const excelProgressText = document.getElementById('excelProgressText');
const excelResult = document.getElementById('excelResult');
const excelCloseBtn = document.getElementById('excelCloseBtn');
const excelCloseBtn2 = document.getElementById('excelCloseBtn2');

function openExcelModal() {
  if (!excelModal) return;
  excelDropZone.style.display = '';
  excelProgress.style.display = 'none';
  excelResult.style.display = 'none';
  excelModal.style.display = 'flex';
}

function closeExcelModal() {
  if (excelModal) excelModal.style.display = 'none';
}

if (excelCloseBtn) excelCloseBtn.addEventListener('click', closeExcelModal);
if (excelCloseBtn2) excelCloseBtn2.addEventListener('click', closeExcelModal);
if (excelModal) {
  excelModal.addEventListener('click', (e) => {
    if (e.target === excelModal) closeExcelModal();
  });
}

// Click drop zone to open file picker
if (excelDropZone) {
  excelDropZone.addEventListener('click', () => excelFileInput && excelFileInput.click());
}

// Drag and drop
if (excelDropZone) {
  excelDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    excelDropZone.classList.add('excel-drop-zone--active');
  });
  excelDropZone.addEventListener('dragleave', () => {
    excelDropZone.classList.remove('excel-drop-zone--active');
  });
  excelDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    excelDropZone.classList.remove('excel-drop-zone--active');
    const file = e.dataTransfer.files[0];
    if (file) uploadExcelFile(file);
  });
}

// File input change
if (excelFileInput) {
  excelFileInput.addEventListener('change', () => {
    const file = excelFileInput.files[0];
    if (file) uploadExcelFile(file);
    excelFileInput.value = '';
  });
}

async function uploadExcelFile(file) {
  if (!file) return;
  const name = file.name.toLowerCase();
  if (!name.endsWith('.xls') && !name.endsWith('.xlsx')) {
    alert('Выберите файл .xls или .xlsx');
    return;
  }

  // Show progress
  excelDropZone.style.display = 'none';
  excelProgress.style.display = '';
  excelResult.style.display = 'none';
  excelProgressFill.style.width = '0%';
  excelProgressText.textContent = 'Чтение файла...';

  try {
    // Read file as base64
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = e.target.result.split(',')[1];
      excelProgressFill.style.width = '50%';
      excelProgressText.textContent = 'Загрузка на сервер...';

      try {
        const resp = await fetch('/api/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileBase64: base64, fileName: file.name }),
        });
        const result = await resp.json();
        excelProgressFill.style.width = '100%';
        excelProgress.style.display = 'none';
        excelResult.style.display = '';

        if (result.duplicate) {
          excelResult.innerHTML = `
            <div class="excel-result-icon excel-result-icon--warn">⚠</div>
            <div class="excel-result-text">
              <strong>Файл уже загружен</strong><br>
              ${result.message}
            </div>`;
        } else if (result.ok) {
          const dataRows = result.data || [];
          let tableHtml = '';
          if (dataRows.length > 0) {
            tableHtml = `
              <div class="excel-imported-list">
                <div class="excel-imported-header">Добавленные записи (${dataRows.length})</div>
                <div class="excel-imported-scroll">
                  <table class="excel-imported-table">
                    <thead>
                      <tr>
                        <th>№</th>
                        <th>ФИО</th>
                        <th>Место работы</th>
                        <th>Должность</th>
                        <th>Курс</th>
                        <th>Год</th>
                        <th>Сроки</th>
                        <th>Дата начала</th>
                        <th>Дата окончания</th>
                        <th>Район</th>
                        <th>Тип ОУ</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${dataRows.map((r) => `
                        <tr>
                          <td>${r.number || ''}</td>
                          <td>${r.name || ''}</td>
                          <td>${r.workplace || ''}</td>
                          <td>${r.position || ''}</td>
                          <td>${r.course || ''}</td>
                          <td>${r.year || ''}</td>
                          <td>${r.period || ''}</td>
                          <td>${r.date_start || ''}</td>
                          <td>${r.date_end || ''}</td>
                          <td>${r.district || ''}</td>
                          <td>${r.org_type || ''}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
              </div>`;
          }
          excelResult.innerHTML = `
            <div class="excel-result-icon excel-result-icon--ok">✓</div>
            <div class="excel-result-text">
              <strong>Импорт завершён</strong><br>
              Файл: ${file.name}<br>
              Записей: ${result.rows}<br>
              Год: ${result.year || '—'}
            </div>
            ${tableHtml}`;
          // Reload data
          if (currentView === 'course') reloadParticipants();
          else if (currentView === 'year') reloadCourses();
          else if (currentView === 'registry') navigateTo('registry');
        } else {
          excelResult.innerHTML = `
            <div class="excel-result-icon excel-result-icon--err">✕</div>
            <div class="excel-result-text">
              <strong>Ошибка</strong><br>
              ${result.error || 'Неизвестная ошибка'}
            </div>`;
        }
      } catch (err) {
        excelProgress.style.display = 'none';
        excelResult.style.display = '';
        excelResult.innerHTML = `
          <div class="excel-result-icon excel-result-icon--err">✕</div>
          <div class="excel-result-text">
            <strong>Ошибка загрузки</strong><br>
            ${err.message}
          </div>`;
      }
    };
    reader.onerror = () => {
      excelProgress.style.display = 'none';
      excelResult.style.display = '';
      excelResult.innerHTML = `
        <div class="excel-result-icon excel-result-icon--err">✕</div>
        <div class="excel-result-text">
          <strong>Не удалось прочитать файл</strong>
        </div>`;
    };
    reader.readAsDataURL(file);
  } catch (err) {
    excelProgress.style.display = 'none';
    excelResult.style.display = '';
    excelResult.innerHTML = `
      <div class="excel-result-icon excel-result-icon--err">✕</div>
      <div class="excel-result-text">
        <strong>Ошибка</strong><br>${err.message}
      </div>`;
  }
}

// ===== Header buttons =====
// Grid/list toggle — two-button segmented control
const gridToggleBtn = document.getElementById('gridToggleBtn');
if (gridToggleBtn) {
  gridToggleBtn.querySelectorAll('.view-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      gridToggleBtn.querySelectorAll('.view-toggle-btn').forEach((b) => b.classList.remove('view-toggle-btn--active'));
      btn.classList.add('view-toggle-btn--active');
      const mode = btn.dataset.view;
      if (mode === 'grid') {
        rowsContainer.classList.add('grid-view');
      } else {
        rowsContainer.classList.remove('grid-view');
      }
    });
  });
}

// Nav menu — hover dropdown (Реестр, Эксперты, Статистика, Отчёт, Настройки)
document.querySelectorAll('.nav-menu-item').forEach((item) => {
  item.addEventListener('click', () => {
    const action = item.dataset.navAction;
    if (action === 'registry') {
      closeStatsPage();
      closeReportPage();
      navigateTo('registry');
    } else if (action === 'experts') {
      alert('Эксперты — в разработке');
    } else if (action === 'stats') {
      openStatsPage();
    } else if (action === 'report') {
      openReportPage();
    } else if (action === 'settings') {
      openSettingsModal();
    }
  });
});

// ===== Statistics Page =====
const statsPage = document.getElementById('statsPage');
const statsCards = document.getElementById('statsCards');
const statsChart = document.getElementById('statsChart');
const statsChartTitle = document.getElementById('statsChartTitle');
const statsBreakdown = document.getElementById('statsBreakdown');
const statsMetricDropdown = document.getElementById('statsMetricDropdown');
const statsChartDropdown = document.getElementById('statsChartDropdown');
const statsShowAllWrap = document.getElementById('statsShowAllWrap');
const statsShowAll = document.getElementById('statsShowAll');
const mainContent = document.querySelector('.main-content');

let statsData = null;
let statsMetric = 'listeners'; // listeners | records | courses | workplaces
let statsChartType = 'year'; // year | org_type | district | position | course | workplace | listeners

const metricLabels = {
  listeners: 'Слушатели',
  records: 'Записи',
  courses: 'Курсы',
  workplaces: 'Учреждения',
};

const chartLabels = {
  year: 'Динамика по годам',
  org_type: 'По типу ОУ',
  district: 'По району',
  position: 'По должности',
  course: 'По курсам',
  workplace: 'По учреждениям',
  listeners: 'Топ слушателей',
};

function openStatsPage() {
  if (!statsPage) return;
  // Hide main content elements
  if (breadcrumbs) breadcrumbs.style.display = 'none';
  if (searchFilterBar) searchFilterBar.style.display = 'none';
  if (activeFiltersBar) activeFiltersBar.style.display = 'none';
  if (footerPaginationBar) footerPaginationBar.style.display = 'none';
  rowsContainer.style.display = 'none';
  statsPage.style.display = '';
  loadStats();
}

function closeStatsPage() {
  if (!statsPage) return;
  statsPage.style.display = 'none';
  if (breadcrumbs) breadcrumbs.style.display = '';
  if (searchFilterBar) searchFilterBar.style.display = '';
  rowsContainer.style.display = '';
  isSearchMode = false;
  searchQuery = '';
}

// ===== Report Page =====
const reportPage = document.getElementById('reportPage');
const reportSummary = document.getElementById('reportSummary');
const reportTableWrap = document.getElementById('reportTableWrap');
const reportClearBtn = document.getElementById('reportClearBtn');
const reportExportCsvBtn = document.getElementById('reportExportCsvBtn');
const reportPrintBtn = document.getElementById('reportPrintBtn');
const reportTitleInput = document.getElementById('reportTitleInput');
const reportSaveBtn = document.getElementById('reportSaveBtn');
const reportHistoryList = document.getElementById('reportHistoryList');
const reportHistoryCount = document.getElementById('reportHistoryCount');

// Saved reports in localStorage
const SAVED_REPORTS_KEY = 'crm_saved_reports';

function getSavedReports() {
  try {
    const raw = localStorage.getItem(SAVED_REPORTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function setSavedReports(reports) {
  try {
    localStorage.setItem(SAVED_REPORTS_KEY, JSON.stringify(reports));
  } catch (e) {
    showToast('Не удалось сохранить: нет места');
  }
}

function renderReportHistory() {
  if (!reportHistoryList || !reportHistoryCount) return;
  const reports = getSavedReports();
  reportHistoryCount.textContent = reports.length;

  if (reports.length === 0) {
    reportHistoryList.innerHTML = '<div class="report-history-empty">Нет сохранённых отчётов. Нажмите «Сохранить», чтобы добавить текущий отчёт в историю.</div>';
    return;
  }

  let html = '';
  reports.forEach((r) => {
    const dateStr = new Date(r.savedAt).toLocaleDateString('ru') + ' ' +
                    new Date(r.savedAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
    html += `
      <div class="report-history-item" data-report-saved-id="${escapeHtml(r.id)}">
        <div class="report-history-item-info">
          <div class="report-history-item-title">${escapeHtml(r.title || 'Без названия')}</div>
          <div class="report-history-item-meta">
            <span>${r.items.length} ${r.items.length === 1 ? 'запись' : 'записей'}</span>
            <span class="report-history-dot">·</span>
            <span>${dateStr}</span>
          </div>
        </div>
        <div class="report-history-item-actions">
          <button class="report-history-btn" data-action="load" data-id="${escapeHtml(r.id)}" title="Загрузить">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7l3 3 7-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="report-history-btn report-history-btn--danger" data-action="delete" data-id="${escapeHtml(r.id)}" title="Удалить">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
    `;
  });
  reportHistoryList.innerHTML = html;

  reportHistoryList.querySelectorAll('.report-history-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === 'load') {
        loadSavedReport(id);
      } else if (action === 'delete') {
        deleteSavedReport(id);
      }
    });
  });
}

function loadSavedReport(id) {
  const reports = getSavedReports();
  const r = reports.find((x) => x.id === id);
  if (!r) return;
  reportItems = new Map();
  r.items.forEach((item) => {
    reportItems.set(String(item.id), item);
  });
  if (reportTitleInput) reportTitleInput.value = r.title || 'Отчёт';
  updateReportBadges();
  renderReport();
  renderReportHistory();
  showToast(`Загружен: ${r.title || 'Без названия'}`);
}

function deleteSavedReport(id) {
  let reports = getSavedReports();
  reports = reports.filter((x) => x.id !== id);
  setSavedReports(reports);
  renderReportHistory();
  showToast('Отчёт удалён из истории');
}

if (reportSaveBtn) {
  reportSaveBtn.addEventListener('click', () => {
    const items = Array.from(reportItems.values());
    if (items.length === 0) {
      showToast('Отчёт пуст — нечего сохранять');
      return;
    }
    const title = (reportTitleInput ? reportTitleInput.value.trim() : '') || 'Отчёт от ' + new Date().toLocaleDateString('ru');
    const report = {
      id: 'rpt_' + Date.now(),
      title: title,
      items: items,
      savedAt: new Date().toISOString(),
    };
    const reports = getSavedReports();
    reports.unshift(report);
    setSavedReports(reports);
    renderReportHistory();
    showToast(`Сохранён: ${title} (${items.length} записей)`);
  });
}

function openReportPage() {
  if (!reportPage) return;
  // Hide other views
  if (statsPage) statsPage.style.display = 'none';
  if (breadcrumbs) breadcrumbs.style.display = 'none';
  if (searchFilterBar) searchFilterBar.style.display = 'none';
  if (activeFiltersBar) activeFiltersBar.style.display = 'none';
  if (footerPaginationBar) footerPaginationBar.style.display = 'none';
  rowsContainer.style.display = 'none';
  if (selectionBar) selectionBar.style.display = 'none';
  reportPage.style.display = '';
  renderReport();
  renderReportHistory();
}

function closeReportPage() {
  if (!reportPage) return;
  reportPage.style.display = 'none';
  if (breadcrumbs) breadcrumbs.style.display = '';
  if (searchFilterBar) searchFilterBar.style.display = '';
  rowsContainer.style.display = '';
  isSearchMode = false;
  searchQuery = '';
}

function renderReport() {
  if (!reportSummary || !reportTableWrap) return;
  const items = Array.from(reportItems.values());

  // Summary
  if (items.length === 0) {
    reportSummary.innerHTML = '';
    reportTableWrap.innerHTML = '<div class="empty-state">Отчёт пуст. Отметьте сотрудников в реестре и нажмите «В отчёт».</div>';
    return;
  }

  // Count unique people and courses
  const names = new Set(items.map((i) => i.name));
  const courses = new Set(items.map((i) => i.course));
  const years = new Set(items.map((i) => String(i.year)));

  reportSummary.innerHTML = `
    <div class="report-stat"><span class="report-stat-val">${items.length}</span><span class="report-stat-label">записей</span></div>
    <div class="report-stat"><span class="report-stat-val">${names.size}</span><span class="report-stat-label">слушателей</span></div>
    <div class="report-stat"><span class="report-stat-val">${courses.size}</span><span class="report-stat-label">курсов</span></div>
    <div class="report-stat"><span class="report-stat-val">${years.size}</span><span class="report-stat-label">лет</span></div>
  `;

  // Table
  let html = `
    <table class="report-table">
      <thead>
        <tr>
          <th>№</th>
          <th>ФИО</th>
          <th>Год</th>
          <th>Курс</th>
          <th>Место работы</th>
          <th>Должность</th>
          <th>Район</th>
          <th>Тип ОУ</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
  `;
  items.forEach((item, idx) => {
    html += `
      <tr data-report-id="${escapeHtml(String(item.id))}">
        <td class="rt-num">${idx + 1}</td>
        <td class="rt-name">${escapeHtml(item.name || '')}</td>
        <td class="rt-year">${escapeHtml(String(item.year || ''))}</td>
        <td class="rt-course">${escapeHtml(item.course || '')}</td>
        <td class="rt-workplace">${escapeHtml(item.workplace || '')}</td>
        <td class="rt-position">${escapeHtml(item.position || '')}</td>
        <td class="rt-district">${escapeHtml(item.district || '')}</td>
        <td class="rt-orgtype">${escapeHtml(item.org_type || '')}</td>
        <td class="rt-actions"><button class="rt-remove" data-report-id="${escapeHtml(String(item.id))}" aria-label="Удалить">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button></td>
      </tr>
    `;
  });
  html += `</tbody></table>`;
  reportTableWrap.innerHTML = html;

  // Bind remove buttons
  reportTableWrap.querySelectorAll('.rt-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.reportId;
      reportItems.delete(id);
      updateReportBadges();
      renderReport();
    });
  });
}

if (reportClearBtn) {
  reportClearBtn.addEventListener('click', () => {
    if (reportItems.size === 0) return;
    if (confirm(`Очистить отчёт (${reportItems.size} записей)?`)) {
      reportItems.clear();
      updateReportBadges();
      renderReport();
    }
  });
}

if (reportExportCsvBtn) {
  reportExportCsvBtn.addEventListener('click', () => {
    const items = Array.from(reportItems.values());
    if (items.length === 0) return;
    const rptTitle = (reportTitleInput ? reportTitleInput.value.trim() : '') || 'Отчёт';
    // Send to server for XLSX with auto-width columns
    fetch('/api/report/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: rptTitle, items: items }),
    })
      .then((res) => {
        if (!res.ok) throw new Error('Export failed');
        return res.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${rptTitle.replace(/[\\/:*?"<>|]/g, '_')}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('Экспортировано в Excel');
      })
      .catch(() => {
        showToast('Ошибка экспорта');
      });
  });
}

// ===== Add entire course to report =====
const addCourseToReportBtn = document.getElementById('addCourseToReportBtn');
if (addCourseToReportBtn) {
  addCourseToReportBtn.addEventListener('click', async () => {
    if (currentView !== 'course' || allParticipants.length === 0) {
      showToast('Нет участников для добавления');
      return;
    }
    let added = 0;
    allParticipants.forEach((item) => {
      if (!reportItems.has(String(item.id))) {
        reportItems.set(String(item.id), item);
        added++;
      }
    });
    updateReportBadges();
    if (added > 0) {
      showToast(`Добавлено в отчёт: ${added}. Всего: ${reportItems.size}`);
    } else {
      showToast('Все участники курса уже в отчёте');
    }
  });
}

if (reportPrintBtn) {
  reportPrintBtn.addEventListener('click', () => {
    const items = Array.from(reportItems.values());
    if (items.length === 0) return;
    const win = window.open('', '_blank');
    let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Отчёт</title>
      <style>
        @page { size: A4 landscape; margin: 12mm; }
        * { box-sizing: border-box; }
        body { font-family: Arial, sans-serif; padding: 0; margin: 0; }
        h2 { margin: 0 0 12px; font-size: 16px; }
        .meta { margin-bottom: 10px; font-size: 11px; color: #666; }
        table { width: 100%; border-collapse: collapse; font-size: 10px; table-layout: fixed; }
        th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; vertical-align: top; word-wrap: break-word; overflow-wrap: break-word; }
        th { background: #f0f0f0; font-weight: 600; }
        tr:nth-child(even) { background: #fafafa; }
        .col-num { width: 30px; text-align: center; }
        .col-year { width: 45px; text-align: center; }
        .col-name { width: 140px; font-weight: 600; }
        .col-course { width: 26%; }
        .col-workplace { width: 22%; }
        .col-position { width: 12%; }
        .col-district { width: 9%; }
        .col-orgtype { width: 10%; }
        @media print { body { padding: 0; } }
      </style></head><body>`;
    const rptTitle = (reportTitleInput ? reportTitleInput.value.trim() : '') || 'Отчёт';
    html += `<h2>${escapeHtml(rptTitle)} (${items.length} ${items.length === 1 ? 'запись' : 'записей'})</h2>`;
    html += `<div class="meta">Дата формирования: ${new Date().toLocaleDateString('ru')}</div>`;
    html += `<table><thead><tr>
      <th class="col-num">№</th>
      <th class="col-name">ФИО</th>
      <th class="col-year">Год</th>
      <th class="col-course">Курс</th>
      <th class="col-workplace">Место работы</th>
      <th class="col-position">Должность</th>
      <th class="col-district">Район</th>
      <th class="col-orgtype">Тип ОУ</th>
    </tr></thead><tbody>`;
    items.forEach((item, idx) => {
      html += `<tr>
        <td class="col-num">${idx + 1}</td>
        <td class="col-name">${escapeHtml(item.name || '')}</td>
        <td class="col-year">${escapeHtml(String(item.year || ''))}</td>
        <td class="col-course">${escapeHtml(item.course || '')}</td>
        <td class="col-workplace">${escapeHtml(item.workplace || '')}</td>
        <td class="col-position">${escapeHtml(item.position || '')}</td>
        <td class="col-district">${escapeHtml(item.district || '')}</td>
        <td class="col-orgtype">${escapeHtml(item.org_type || '')}</td>
      </tr>`;
    });
    html += `</tbody></table></body></html>`;
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
  });
}

async function loadStats() {
  if (!statsData) {
    try {
      statsData = await apiGet('/api/stats');
    } catch (e) {
      statsData = null;
      if (statsCards) statsCards.innerHTML = '<div class="empty-state">Ошибка загрузки статистики</div>';
      return;
    }
  }
  renderStatsCards();
  renderStatsChart();
  renderStatsBreakdown();
}

function renderStatsCards() {
  if (!statsCards || !statsData) return;
  const t = statsData.totals;
  statsCards.innerHTML = `
    <div class="stat-card">
      <div class="stat-card-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.5"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </div>
      <div class="stat-card-body">
        <div class="stat-card-value">${t.listeners.toLocaleString('ru')}</div>
        <div class="stat-card-label">Всего слушателей</div>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-card-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </div>
      <div class="stat-card-body">
        <div class="stat-card-value">${t.records.toLocaleString('ru')}</div>
        <div class="stat-card-label">Всего записей</div>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-card-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M6 4h12v4H6zM6 10h12v4H6zM6 16h12v4H6z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
      </div>
      <div class="stat-card-body">
        <div class="stat-card-value">${t.courses.toLocaleString('ru')}</div>
        <div class="stat-card-label">Курсов</div>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-card-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="stat-card-body">
        <div class="stat-card-value">${t.workplaces.toLocaleString('ru')}</div>
        <div class="stat-card-label">Учреждений</div>
      </div>
    </div>
  `;
}

function shortenLabel(text) {
  if (!text) return '';
  return text
    .replace(/муниципальное бюджетное общеобразовательное учреждение/gi, 'МБОУ')
    .replace(/муниципальное бюджетное дошкольное образовательное учреждение/gi, 'МБДОУ')
    .replace(/муниципальное дошкольное образовательное учреждение/gi, 'МДОУ')
    .replace(/муниципальное автономное общеобразовательное учреждение/gi, 'МАОУ')
    .replace(/муниципальное казённое общеобразовательное учреждение/gi, 'МКОУ')
    .replace(/муниципальное образовательное учреждение/gi, 'МОУ')
    .replace(/общеобразовательное учреждение/gi, 'ОУ')
    .replace(/дошкольное образовательное учреждение/gi, 'ДОУ')
    .replace(/образовательное учреждение/gi, 'ОУ');
}

function renderStatsChart() {
  if (!statsChart || !statsData) return;

  const isYearChart = statsChartType === 'year';
  const isTopChart = statsChartType !== 'year'; // non-year charts can show all

  // Update title
  let title = chartLabels[statsChartType];
  const showAll = statsShowAll && statsShowAll.checked;
  if (isTopChart && !showAll) title += ' (топ-10)';
  statsChartTitle.textContent = title;

  // Show/hide "Показать всех" toggle
  if (statsShowAllWrap) {
    statsShowAllWrap.style.display = isTopChart ? '' : 'none';
  }

  let items = [];
  let metricKey = statsMetric;

  if (statsChartType === 'year') {
    items = statsData.by_year.map((y) => ({
      label: String(y.year),
      value: y[metricKey] || 0,
    }));
  } else if (statsChartType === 'org_type') {
    items = statsData.by_org_type.map((r) => ({
      label: r.org_type,
      value: metricKey === 'listeners' ? r.listeners : r.count,
    }));
  } else if (statsChartType === 'district') {
    items = statsData.by_district.map((r) => ({
      label: r.district,
      value: metricKey === 'listeners' ? r.listeners : r.count,
    }));
  } else if (statsChartType === 'position') {
    items = statsData.by_position.map((r) => ({
      label: r.position,
      value: r.count,
    }));
  } else if (statsChartType === 'course') {
    items = statsData.by_course.map((r) => ({
      label: r.course,
      value: metricKey === 'listeners' ? r.listeners : r.count,
    }));
  } else if (statsChartType === 'workplace') {
    items = statsData.by_workplace.map((r) => ({
      label: r.workplace,
      value: metricKey === 'listeners' ? r.listeners : r.count,
    }));
  } else if (statsChartType === 'listeners') {
    items = statsData.by_top_listeners.map((r) => ({
      label: r.name,
      value: r.count,
    }));
  }

  // Slice to top 10 unless "show all" is checked
  if (isTopChart && !showAll) {
    items = items.slice(0, 10);
  }

  if (items.length === 0) {
    statsChart.innerHTML = '<div class="empty-state">Нет данных</div>';
    return;
  }

  const maxVal = Math.max(...items.map((i) => i.value));
  const isHorizontal = statsChartType !== 'year';

  if (isHorizontal) {
    // Horizontal bar chart with resizable label column
    let html = '<div class="h-bar-chart" id="hBarChart">';
    html += `
      <div class="h-bar-resize-hint">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 2v10M9 2v10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        <span>Потяните разделитель, чтобы изменить ширину подписей</span>
      </div>`;
    items.forEach((item) => {
      const pct = maxVal > 0 ? (item.value / maxVal * 100) : 0;
      const labelShort = shortenLabel(item.label);
      const fullLabel = item.label;
      html += `
        <div class="h-bar-row">
          <div class="h-bar-label" title="${escapeHtml(fullLabel)}">${escapeHtml(labelShort)}</div>
          <div class="h-bar-divider" title="Потяните влево/вправо"></div>
          <div class="h-bar-track">
            <div class="h-bar-fill" style="width: ${pct}%"></div>
          </div>
          <div class="h-bar-value">${item.value.toLocaleString('ru')}</div>
        </div>`;
    });
    html += '</div>';
    statsChart.innerHTML = html;

    // Setup drag-resize for label column
    setupHBarResize();
  } else {
    // Vertical bar chart (years) — animated with change indicators
    let html = '<div class="v-bar-chart">';
    items.forEach((item, i) => {
      const pct = maxVal > 0 ? (item.value / maxVal * 100) : 0;
      // Calculate change from previous year
      let changeHtml = '';
      if (i > 0) {
        const prev = items[i - 1].value;
        const diff = item.value - prev;
        if (prev !== 0) {
          const pctChange = Math.round((diff / prev) * 100);
          const sign = diff > 0 ? '+' : '';
          const cls = diff > 0 ? 'v-bar-change--up' : diff < 0 ? 'v-bar-change--down' : '';
          if (cls) {
            changeHtml = `<div class="v-bar-change ${cls}">${sign}${pctChange}%</div>`;
          }
        }
      }
      html += `
        <div class="v-bar-col">
          ${changeHtml}
          <div class="v-bar-value">${item.value.toLocaleString('ru')}</div>
          <div class="v-bar-track">
            <div class="v-bar-fill" style="height: ${pct}%; animation-delay: ${i * 0.15}s"></div>
          </div>
          <div class="v-bar-label">${escapeHtml(item.label)}</div>
        </div>`;
    });
    html += '</div>';

    // Legend for year chart
    if (items.length > 0) {
      html += `
        <div class="stats-chart-legend">
          <div class="stats-legend-item">
            <span class="stats-legend-label">Высота бара</span>
            <span class="stats-legend-desc">— количество ${metricLabels[metricKey].toLowerCase()} за год</span>
          </div>
          <div class="stats-legend-item">
            <span class="stats-legend-badge stats-legend-badge--up">+X%</span>
            <span class="stats-legend-desc">— прирост по сравнению с предыдущим годом</span>
          </div>
          <div class="stats-legend-item">
            <span class="stats-legend-badge stats-legend-badge--down">−X%</span>
            <span class="stats-legend-desc">— снижение по сравнению с предыдущим годом</span>
          </div>
        </div>`;
    }

    statsChart.innerHTML = html;
  }
}

// Drag-to-resize label column in horizontal bar chart
function setupHBarResize() {
  const container = document.getElementById('hBarChart');
  if (!container) return;

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  const dividers = container.querySelectorAll('.h-bar-divider');
  dividers.forEach((divider) => {
    divider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startWidth = container.querySelector('.h-bar-label').offsetWidth;
      container.classList.add('h-bar-chart--dragging');
      document.body.style.cursor = 'col-resize';
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newWidth = Math.max(80, Math.min(600, startWidth + delta));
    container.style.setProperty('--h-bar-label-width', newWidth + 'px');
  });

  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      container.classList.remove('h-bar-chart--dragging');
      document.body.style.cursor = '';
    }
  });
}

function renderStatsBreakdown() {
  if (!statsBreakdown || !statsData) return;
  const t = statsData.totals;
  const years = statsData.years || [];

  let html = '<div class="stats-breakdown-grid">';

  // Years table
  html += `
    <div class="stats-table-card">
      <div class="stats-table-title">По годам</div>
      <table class="stats-table">
        <thead><tr><th>Год</th><th>Записей</th><th>Слушателей</th><th>Курсов</th><th>Учреждений</th></tr></thead>
        <tbody>
          ${statsData.by_year.map((y) => `
            <tr>
              <td><strong>${y.year}</strong></td>
              <td>${y.records.toLocaleString('ru')}</td>
              <td>${y.listeners.toLocaleString('ru')}</td>
              <td>${y.courses.toLocaleString('ru')}</td>
              <td>${y.workplaces.toLocaleString('ru')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  // Org types
  html += `
    <div class="stats-table-card">
      <div class="stats-table-title">По типу ОУ</div>
      <table class="stats-table">
        <thead><tr><th>Тип</th><th>Записей</th><th>Слушателей</th></tr></thead>
        <tbody>
          ${statsData.by_org_type.map((r) => `
            <tr>
              <td>${escapeHtml(r.org_type)}</td>
              <td>${r.count.toLocaleString('ru')}</td>
              <td>${r.listeners.toLocaleString('ru')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  // Districts
  html += `
    <div class="stats-table-card">
      <div class="stats-table-title">По районам</div>
      <table class="stats-table">
        <thead><tr><th>Район</th><th>Записей</th><th>Слушателей</th></tr></thead>
        <tbody>
          ${statsData.by_district.map((r) => `
            <tr>
              <td>${escapeHtml(r.district)}</td>
              <td>${r.count.toLocaleString('ru')}</td>
              <td>${r.listeners.toLocaleString('ru')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  // Top positions
  html += `
    <div class="stats-table-card">
      <div class="stats-table-title">Топ-10 должностей</div>
      <table class="stats-table">
        <thead><tr><th>Должность</th><th>Записей</th></tr></thead>
        <tbody>
          ${statsData.by_position.map((r) => `
            <tr>
              <td>${escapeHtml(r.position)}</td>
              <td>${r.count.toLocaleString('ru')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  html += '</div>';
  statsBreakdown.innerHTML = html;
}

// Stats dropdown handlers
if (statsMetricDropdown) {
  statsMetricDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
    const items = [
      { value: 'listeners', label: 'Слушатели' },
      { value: 'records', label: 'Записи' },
      { value: 'courses', label: 'Курсы' },
      { value: 'workplaces', label: 'Учреждения' },
    ];
    showDropdownMenu(statsMetricDropdown, items, (value, label) => {
      statsMetricDropdown.querySelector('.dropdown-value').textContent = label;
      statsMetric = value;
      renderStatsChart();
    });
  });
}

if (statsChartDropdown) {
  statsChartDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
    const items = [
      { value: 'year', label: 'Динамика по годам' },
      { value: 'org_type', label: 'По типу ОУ' },
      { value: 'district', label: 'По району' },
      { value: 'position', label: 'По должности' },
      { value: 'course', label: 'По курсам' },
      { value: 'workplace', label: 'По учреждениям' },
      { value: 'listeners', label: 'Топ слушателей' },
    ];
    showDropdownMenu(statsChartDropdown, items, (value, label) => {
      statsChartDropdown.querySelector('.dropdown-value').textContent = label;
      statsChartType = value;
      if (statsShowAll) statsShowAll.checked = false;
      renderStatsChart();
    });
  });
}

if (statsShowAll) {
  statsShowAll.addEventListener('change', () => {
    renderStatsChart();
  });
}

// ===== Settings Panel =====
const settingsModal = document.getElementById('settingsModal');
const settingsCloseBtn = document.getElementById('settingsCloseBtn');
const settingsDoneBtn = document.getElementById('settingsDoneBtn');
const settingsWipeBtn = document.getElementById('settingsWipeBtn');
const settingsRefreshBtn = document.getElementById('settingsRefreshImports');
const settingsImportsCount = document.getElementById('settingsImportsCount');
const settingsImportsList = document.getElementById('settingsImportsList');

async function openSettingsModal() {
  if (!settingsModal) return;
  settingsModal.style.display = 'flex';
  await loadSettingsImports();
}

async function loadSettingsImports() {
  if (settingsImportsCount) settingsImportsCount.textContent = 'Загрузка...';
  if (settingsImportsList) settingsImportsList.textContent = 'Загрузка...';
  try {
    const imports = await apiGet('/api/imports');
    if (settingsImportsCount) {
      settingsImportsCount.textContent = `Загружено файлов: ${imports.length}`;
    }
    if (settingsImportsList) {
      if (imports.length === 0) {
        settingsImportsList.innerHTML = '<div class="settings-empty">Нет загруженных файлов</div>';
      } else {
        settingsImportsList.innerHTML = imports.map((imp) => `
          <div class="settings-import-row">
            <div class="settings-import-info">
              <div class="settings-import-name">${imp.original_name || imp.original_name}</div>
              <div class="settings-import-meta">Год: ${imp.year || '—'} • Загружен: ${imp.uploaded_at || ''}</div>
            </div>
          </div>
        `).join('');
      }
    }
  } catch (e) {
    if (settingsImportsCount) settingsImportsCount.textContent = 'Ошибка загрузки';
    if (settingsImportsList) settingsImportsList.textContent = 'Ошибка загрузки';
  }
}

if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', () => { settingsModal.style.display = 'none'; });
if (settingsDoneBtn) settingsDoneBtn.addEventListener('click', () => { settingsModal.style.display = 'none'; });
if (settingsModal) {
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) settingsModal.style.display = 'none';
  });
}
if (settingsRefreshBtn) settingsRefreshBtn.addEventListener('click', loadSettingsImports);

if (settingsWipeBtn) {
  settingsWipeBtn.addEventListener('click', () => {
    const wipeDialog = document.getElementById('wipeDialog');
    if (wipeDialog) wipeDialog.style.display = 'flex';
  });
}

// Wipe dialog handlers
const wipeDialog = document.getElementById('wipeDialog');
const wipeCloseBtn = document.getElementById('wipeCloseBtn');
const wipeCancelBtn = document.getElementById('wipeCancelBtn');
const wipeDbOnly = document.getElementById('wipeDbOnly');
const wipeAll = document.getElementById('wipeAll');

function closeWipeDialog() {
  if (wipeDialog) wipeDialog.style.display = 'none';
}

if (wipeCloseBtn) wipeCloseBtn.addEventListener('click', closeWipeDialog);
if (wipeCancelBtn) wipeCancelBtn.addEventListener('click', closeWipeDialog);
if (wipeDialog) {
  wipeDialog.addEventListener('click', (e) => {
    if (e.target === wipeDialog) closeWipeDialog();
  });
}

async function doWipe(deleteFiles) {
  closeWipeDialog();
  settingsWipeBtn.disabled = true;
  settingsWipeBtn.textContent = 'Удаление...';
  try {
    const result = await apiPost('/api/reset', { delete_files: deleteFiles });
    settingsWipeBtn.textContent = 'Удалено';
    settingsWipeBtn.disabled = false;
    setTimeout(() => { settingsWipeBtn.textContent = 'Удалить всё'; }, 2000);
    await loadSettingsImports();
    navigateTo('registry');
    if (deleteFiles && result.deleted_files && result.deleted_files.length > 0) {
      alert(`Удалено файлов: ${result.deleted_files.length}\n\n${result.deleted_files.join('\n')}`);
    }
  } catch (e) {
    alert('Ошибка: ' + e.message);
    settingsWipeBtn.disabled = false;
    settingsWipeBtn.textContent = 'Удалить всё';
  }
}

if (wipeDbOnly) wipeDbOnly.addEventListener('click', () => doWipe(false));
if (wipeAll) wipeAll.addEventListener('click', () => doWipe(true));

// "Профиль" — toggle profile dropdown
const profileBtn = document.getElementById('profileBtn');
const profileDropdown = document.getElementById('profileDropdown');
const profileLogoutBtn = document.getElementById('profileLogoutBtn');

if (profileBtn && profileDropdown) {
  profileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    profileDropdown.style.display = profileDropdown.style.display === 'none' ? 'block' : 'none';
    if (profileDropdown.style.display === 'block') {
      const rect = profileBtn.getBoundingClientRect();
      profileDropdown.style.top = (rect.bottom + window.scrollY + 8) + 'px';
      profileDropdown.style.right = (window.innerWidth - rect.right + window.scrollX) + 'px';
    }
  });
}

document.addEventListener('click', (e) => {
  if (profileDropdown && profileDropdown.style.display === 'block' &&
      !profileBtn.contains(e.target) && !profileDropdown.contains(e.target)) {
    profileDropdown.style.display = 'none';
  }
});

if (profileLogoutBtn) {
  profileLogoutBtn.addEventListener('click', () => {
    window.location.href = 'login.html';
  });
}

// ===== Logout =====
const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', () => {
    window.location.href = 'login.html';
  });
}

// ===== Init =====
navigateTo('registry');

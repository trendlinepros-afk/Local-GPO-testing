'use strict';

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

async function unwrap(promise) {
  const res = await promise;
  if (!res || !res.ok) throw new Error((res && res.error) || 'Unknown error');
  return res.data;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  platform: null,
  baselines: [],
  standardId: null,
  comparison: null,
  selected: new Set(),
  diffOnly: true,
  search: ''
};

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
function toast(message, type = 'info', ms = 4000) {
  const node = el('div', { class: `toast ${type}`, text: message });
  $('#toast-stack').appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 200);
  }, ms);
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
function openModal(title, bodyNode, footButtons = []) {
  $('#modal-title').textContent = title;
  const body = $('#modal-body');
  body.innerHTML = '';
  body.appendChild(bodyNode);
  const foot = $('#modal-foot');
  foot.innerHTML = '';
  for (const b of footButtons) {
    const btn = el('button', { class: `btn ${b.class || 'btn-ghost'}`, type: 'button', text: b.label });
    if (b.id) btn.id = b.id;
    if (!b.onClick) btn.disabled = true;
    btn.addEventListener('click', () => b.onClick && b.onClick(btn));
    foot.appendChild(btn);
  }
  $('#modal-overlay').classList.remove('hidden');
}

function closeModal() {
  $('#modal-overlay').classList.add('hidden');
  $('#modal-body').innerHTML = '';
  $('#modal-foot').innerHTML = '';
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('#modal-overlay')) closeModal();
  });

  $('#btn-check-updates').addEventListener('click', openUpdateModal);
  $('#btn-scan').addEventListener('click', runScan);
  $('#btn-rescan').addEventListener('click', runScan);
  $('#btn-revert').addEventListener('click', openRevertModal);
  $('#btn-export').addEventListener('click', exportReport);
  $('#btn-apply').addEventListener('click', confirmApply);
  $('#btn-select-diff').addEventListener('click', selectAllDiffering);
  $('#btn-clear-sel').addEventListener('click', clearSelection);
  $('#chk-all').addEventListener('change', (e) => toggleAll(e.target.checked));
  $('#filter-diff-only').addEventListener('change', (e) => {
    state.diffOnly = e.target.checked;
    renderComparison();
  });
  $('#cmp-search').addEventListener('input', (e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderComparison();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  wireUpdaterEvents();

  try {
    const [version, platform, baselines] = await Promise.all([
      unwrap(window.api.getAppVersion()),
      unwrap(window.api.getPlatformInfo()),
      unwrap(window.api.listBaselines())
    ]);
    state.platform = platform;
    state.baselines = baselines;
    $('#app-version').textContent = `v${version}`;
    renderEnvBadges();
    renderStandards();
  } catch (err) {
    toast('Failed to start: ' + err.message, 'error', 7000);
  }
}

function renderEnvBadges() {
  const p = state.platform;
  const wrap = $('#env-badges');
  wrap.innerHTML = '';
  if (p.simulation) {
    wrap.appendChild(el('span', { class: 'badge sim', text: 'Simulation mode' }));
    wrap.appendChild(el('span', { class: 'badge', text: p.platform }));
  } else {
    wrap.appendChild(el('span', { class: 'badge ok', text: 'Windows' }));
    wrap.appendChild(
      el('span', {
        class: `badge ${p.admin ? 'ok' : 'warn'}`,
        text: p.admin ? 'Administrator' : 'Not elevated'
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Standards
// ---------------------------------------------------------------------------
function renderStandards() {
  const grid = $('#standards-grid');
  grid.innerHTML = '';
  for (const b of state.baselines) {
    const card = el('button', { class: 'std-card', type: 'button', 'data-id': b.id }, [
      el('div', { class: 'std-short', text: b.shortName }),
      el('div', { class: 'std-full', text: b.name }),
      el('div', { class: 'std-count', text: `${b.settingCount} policy settings` })
    ]);
    card.addEventListener('click', () => selectStandard(b.id));
    grid.appendChild(card);
  }
}

async function selectStandard(id) {
  state.standardId = id;
  state.selected.clear();
  $$('.std-card').forEach((c) => c.classList.toggle('selected', c.getAttribute('data-id') === id));

  const b = state.baselines.find((x) => x.id === id);
  $('#detail-name').textContent = b.name;
  $('#detail-desc').textContent = b.description;
  const ref = $('#detail-ref');
  if (b.reference) {
    ref.href = b.reference;
    ref.classList.remove('hidden');
  } else {
    ref.classList.add('hidden');
  }
  $('#section-detail').classList.remove('hidden');
  $('#section-scan').classList.add('hidden');

  await loadComparison();
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------
async function loadComparison() {
  try {
    const data = await unwrap(window.api.getComparison(state.standardId));
    state.comparison = data;
    // Pre-select all differing settings by default.
    state.selected = new Set(data.rows.filter((r) => r.differs).map((r) => r.id));
    $('#section-compare').classList.remove('hidden');
    renderComparison();
  } catch (err) {
    toast('Failed to load settings: ' + err.message, 'error', 6000);
  }
}

function renderComparison() {
  const data = state.comparison;
  if (!data) return;
  const body = $('#cmp-body');
  body.innerHTML = '';

  let rows = state.diffOnly ? data.rows.filter((r) => r.differs) : data.rows;
  if (state.search) {
    rows = rows.filter(
      (r) => r.name.toLowerCase().includes(state.search) || r.category.toLowerCase().includes(state.search)
    );
  }
  if (!rows.length) {
    body.appendChild(
      el('tr', {}, [el('td', { colspan: '6', class: 'muted', style: 'padding:18px;' }, 'No settings match.')])
    );
  }

  for (const r of rows) {
    const chk = el('input', { type: 'checkbox' });
    chk.checked = state.selected.has(r.id);
    chk.disabled = !r.differs;
    chk.addEventListener('change', () => {
      if (chk.checked) state.selected.add(r.id);
      else state.selected.delete(r.id);
      updateSelCount();
    });

    const impact = r.generalImpact;
    const impactCell = el('td', { class: 'impact-cell' });
    if (impact) {
      impactCell.appendChild(el('span', { class: `impact-risk ${impact.risk}`, text: impact.risk + ' · ' }));
      impactCell.appendChild(document.createTextNode(impact.detail));
    } else {
      impactCell.textContent = '—';
    }

    const nameCell = el('div', { class: 'setting-name', text: r.name });
    if (r.reboot) nameCell.appendChild(el('span', { class: 'reboot-tag', text: '⟳ restart' }));

    const tr = el('tr', { class: r.differs ? 'diff' : 'same' }, [
      el('td', { class: 'col-chk' }, [chk]),
      el('td', {}, [nameCell, el('div', { class: 'setting-cat', text: r.category })]),
      el('td', { class: 'val-current', text: r.currentDisplay }),
      el('td', { class: 'arrow', text: r.differs ? '→' : '=' }),
      el('td', { class: 'val-desired', text: r.desiredDisplay }),
      impactCell
    ]);
    body.appendChild(tr);
  }
  updateSelCount();
}

function updateSelCount() {
  $('#sel-count').textContent = String(state.selected.size);
  const rows = state.comparison ? state.comparison.rows.filter((r) => r.differs) : [];
  $('#chk-all').checked = rows.length > 0 && rows.every((r) => state.selected.has(r.id));
  if (state.comparison) {
    const s = state.comparison.summary;
    $('#cmp-summary').textContent = `${s.compliant}/${s.total} already compliant · ${s.differing} differ`;
  }
}

function selectAllDiffering() {
  if (!state.comparison) return;
  state.comparison.rows.filter((r) => r.differs).forEach((r) => state.selected.add(r.id));
  renderComparison();
}

function clearSelection() {
  state.selected.clear();
  renderComparison();
}

function toggleAll(checked) {
  if (!state.comparison) return;
  const rows = state.comparison.rows.filter((r) => r.differs);
  if (checked) rows.forEach((r) => state.selected.add(r.id));
  else rows.forEach((r) => state.selected.delete(r.id));
  renderComparison();
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
async function runScan() {
  if (!state.standardId) return;
  const btn = $('#btn-scan');
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = 'Scanning…';
  try {
    const result = await unwrap(window.api.scan(state.standardId));
    renderScan(result);
    $('#section-scan').classList.remove('hidden');
    $('#section-scan').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    toast('Scan failed: ' + err.message, 'error', 6000);
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

function statTile(value, label, cls = '') {
  return el('div', { class: `stat ${cls}` }, [
    el('div', { class: 'stat-val', text: String(value) }),
    el('div', { class: 'stat-lbl', text: label })
  ]);
}

function renderScan(result) {
  const summary = $('#scan-summary');
  summary.innerHTML = '';
  summary.appendChild(statTile(result.changesCount, 'Settings would change'));
  summary.appendChild(statTile(result.byRisk.high, 'High risk', 'high'));
  summary.appendChild(statTile(result.byRisk.medium, 'Medium risk', 'medium'));
  summary.appendChild(statTile(result.byRisk.low, 'Low risk', 'low'));
  summary.appendChild(statTile(result.servicesCount, 'Services scanned'));
  summary.appendChild(statTile(result.processesCount, 'Processes scanned'));

  const list = $('#scan-issues');
  list.innerHTML = '';

  if (result.rebootRequired && result.rebootRequired.length) {
    list.appendChild(
      el('div', { class: 'info-note' }, `⟳ A restart is required to fully apply: ${result.rebootRequired.join(', ')}.`)
    );
  }

  if (!result.issues.length) {
    list.appendChild(
      el('div', { class: 'no-issues' }, [
        el('strong', { text: '✔ No likely breakage detected. ' }),
        document.createTextNode(
          result.changesCount
            ? `${result.changesCount} setting(s) would change, but none matched a running service or high-impact rule.`
            : 'This system already matches the selected baseline.'
        )
      ])
    );
    return;
  }

  const intro = el('p', { class: 'muted', style: 'margin:4px 0 4px;' }, [
    document.createTextNode(
      `Applying ${result.standard.name} would change ${result.changesCount} setting(s). ` +
        `The following are most likely to affect what is running on this system:`
    )
  ]);
  list.appendChild(intro);

  for (const issue of result.issues) {
    const card = el('div', { class: `issue ${issue.risk}` });
    const titleNode = el('div', { class: 'issue-title', text: issue.name });
    if (issue.reboot) titleNode.appendChild(el('span', { class: 'reboot-tag', text: '⟳ restart' }));
    card.appendChild(
      el('div', { class: 'issue-head' }, [titleNode, el('span', { class: `risk-pill ${issue.risk}`, text: issue.risk })])
    );
    card.appendChild(
      el('div', { class: 'issue-change' }, [
        document.createTextNode('Change: '),
        el('b', { text: issue.currentDisplay }),
        document.createTextNode('  →  '),
        el('b', { text: issue.desiredDisplay }),
        document.createTextNode('   ·  ' + issue.category)
      ])
    );

    const reasons = (issue.reasons && issue.reasons.length ? issue.reasons : [issue.generalNote]).filter(Boolean);
    if (reasons.length) {
      const ul = el('ul', { class: 'issue-reasons' });
      reasons.forEach((r) => ul.appendChild(el('li', { text: r })));
      card.appendChild(ul);
    }

    if ((issue.matchedServices && issue.matchedServices.length) || (issue.matchedProcesses && issue.matchedProcesses.length)) {
      const chips = el('div', { class: 'chips' });
      chips.appendChild(el('span', { class: 'chip', text: 'Detected:' }));
      (issue.matchedServices || []).forEach((s) =>
        chips.appendChild(el('span', { class: 'chip svc', text: `${s.displayName} (${s.name})` }))
      );
      (issue.matchedProcesses || []).forEach((p) => chips.appendChild(el('span', { class: 'chip svc', text: p })));
      card.appendChild(chips);
    }
    list.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
function confirmApply() {
  if (!state.comparison) return;
  const ids = Array.from(state.selected);
  if (!ids.length) {
    toast('Select at least one setting to apply.', 'info');
    return;
  }
  const rowsById = Object.fromEntries(state.comparison.rows.map((r) => [r.id, r]));
  const chosen = ids.map((id) => rowsById[id]).filter(Boolean);

  const body = el('div');
  if (!state.platform.simulation && !state.platform.admin) {
    body.appendChild(
      el('div', { class: 'warn-box' },
        '⚠ This app is not running elevated. Writing to Local Group Policy requires Administrator rights and will likely fail. Relaunch as Administrator.')
    );
  }
  if (state.platform.simulation) {
    body.appendChild(
      el('div', { class: 'warn-box' },
        'Simulation mode: changes are recorded against a mock policy store so you can exercise Apply/Revert. Nothing on this machine is modified and gpupdate is not run.')
    );
  }
  body.appendChild(
    el('p', { class: 'muted' }, `The following ${chosen.length} setting(s) will be changed and gpupdate /force will run:`)
  );
  const ul = el('ul', { class: 'list-plain' });
  chosen.forEach((r) => {
    ul.appendChild(
      el('li', {}, [
        el('b', { text: r.name }),
        document.createTextNode(`: ${r.currentDisplay} → ${r.desiredDisplay}`)
      ])
    );
  });
  body.appendChild(ul);

  openModal('Apply settings', body, [
    { label: 'Cancel', class: 'btn-ghost', onClick: closeModal },
    {
      label: `Apply ${chosen.length} & run gpupdate`,
      class: 'btn-primary',
      onClick: (btn) => doApply(ids, btn)
    }
  ]);
}

async function doApply(ids, btn) {
  btn.disabled = true;
  btn.textContent = 'Applying…';
  try {
    const result = await unwrap(window.api.apply(state.standardId, ids));
    closeModal();
    showApplyResult(result);
    await loadComparison();
  } catch (err) {
    closeModal();
    toast('Apply failed: ' + err.message, 'error', 7000);
  }
}

function showApplyResult(result) {
  if (!result.applied) {
    toast(result.message || 'Nothing to apply.', 'info');
    return;
  }
  const body = el('div');
  const okCount = result.batch.changes.filter((c) => c.ok).length;
  const failCount = result.batch.changes.length - okCount;
  body.appendChild(
    el('p', {}, `${okCount} setting(s) applied${failCount ? `, ${failCount} failed` : ''}.`)
  );

  result.batch.changes.forEach((c) => {
    body.appendChild(
      el('div', { class: 'result-line' }, [
        el('span', { class: c.ok ? 'r-ok' : 'r-fail', text: c.ok ? '✔' : '✘' }),
        el('span', {}, [el('b', { text: c.name }), document.createTextNode(`: ${c.oldDisplay} → ${c.newDisplay}`)])
      ])
    );
  });

  if (result.rebootRequired && result.rebootRequired.length) {
    body.appendChild(
      el('div', { class: 'warn-box' }, `⟳ Restart required to fully apply: ${result.rebootRequired.join(', ')}.`)
    );
  }

  const g = result.gpupdate;
  body.appendChild(
    el('div', { class: 'gpupdate-out', text: (g.simulated ? '[simulation] ' : '') + (g.output || `gpupdate exit code ${g.code}`) })
  );

  openModal('Applied', body, [{ label: 'Done', class: 'btn-primary', onClick: closeModal }]);
  toast(`Applied ${okCount} setting(s) and ran gpupdate.`, failCount ? 'error' : 'success');
}

// ---------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------
async function openRevertModal() {
  let batches = [];
  try {
    batches = await unwrap(window.api.getBatches());
  } catch (err) {
    toast('Could not load change history: ' + err.message, 'error');
    return;
  }
  renderRevertModal(batches);
}

function renderRevertModal(batches) {
  const body = el('div');
  const selectedItems = new Set(); // "batchId::settingId"

  if (!batches.length) {
    body.appendChild(el('p', { class: 'muted' }, 'No changes have been applied yet. Apply a baseline first, then you can revert it here.'));
    openModal('Revert changes', body, [{ label: 'Close', class: 'btn-ghost', onClick: closeModal }]);
    return;
  }

  body.appendChild(
    el('p', { class: 'muted' }, 'Each apply is recorded as a batch. Revert everything, a whole batch, selected items, or a single setting. gpupdate /force runs after a revert.')
  );

  const revertActive = batches.some((b) => b.changes.some((c) => c.ok && !c.reverted));

  for (const batch of batches) {
    const box = el('div', { class: 'batch' });
    const head = el('div', { class: 'batch-head' }, [
      el('div', { class: 'batch-meta' }, [
        el('div', { class: 'batch-std', text: `${batch.standardShort || ''} · ${batch.changes.length} change(s)` }),
        el('div', { class: 'batch-time', text: new Date(batch.timestamp).toLocaleString() })
      ]),
      el('div', { style: 'display:flex;gap:10px;align-items:center;' }, [
        el('span', { class: `status-pill ${batch.status}`, text: batch.status.replace('-', ' ') }),
        el('button', {
          class: 'mini-link',
          type: 'button',
          text: 'Revert batch',
          disabled: !batch.changes.some((c) => c.ok && !c.reverted),
          onclick: () => doRevert({ mode: 'batch', batchId: batch.id })
        })
      ])
    ]);
    box.appendChild(head);

    const items = el('div', { class: 'batch-items' });
    for (const c of batch.changes) {
      const key = `${batch.id}::${c.settingId}`;
      const canRevert = c.ok && !c.reverted;

      const chk = el('input', { type: 'checkbox' });
      chk.disabled = !canRevert;
      chk.addEventListener('change', () => {
        if (chk.checked) selectedItems.add(key);
        else selectedItems.delete(key);
      });

      const row = el('div', { class: `batch-item ${c.reverted ? 'reverted' : ''}` }, [
        chk,
        el('span', { class: 'bi-name', text: c.name }),
        el('span', { class: 'bi-change', text: `${c.oldDisplay} → ${c.newDisplay}` }),
        el('button', {
          class: 'mini-link',
          type: 'button',
          text: c.reverted ? 'reverted' : 'revert',
          disabled: !canRevert,
          onclick: () => doRevert({ mode: 'item', batchId: batch.id, settingId: c.settingId })
        })
      ]);
      items.appendChild(row);
    }
    box.appendChild(items);
    body.appendChild(box);
  }

  openModal('Revert changes', body, [
    { label: 'Close', class: 'btn-ghost', onClick: closeModal },
    {
      label: 'Revert selected items',
      class: 'btn-warn',
      onClick: () => {
        if (!selectedItems.size) {
          toast('Tick one or more items first.', 'info');
          return;
        }
        const items = Array.from(selectedItems).map((k) => {
          const [batchId, settingId] = k.split('::');
          return { batchId, settingId };
        });
        doRevert({ mode: 'items', items });
      }
    },
    {
      label: 'Revert ALL changes',
      class: 'btn-danger',
      onClick: () => {
        if (!revertActive) {
          toast('Nothing left to revert.', 'info');
          return;
        }
        doRevert({ mode: 'all' });
      }
    }
  ]);
}

async function doRevert(options) {
  try {
    const result = await unwrap(window.api.revert(options));
    if (!result.reverted) {
      toast(result.message || 'Nothing to revert.', 'info');
      return;
    }
    const okCount = result.results.filter((r) => r.ok).length;
    toast(`Reverted ${okCount} setting(s) and ran gpupdate.`, 'success');
    renderRevertModal(result.batches); // refresh modal in place
    if (state.standardId) await loadComparison();
  } catch (err) {
    toast('Revert failed: ' + err.message, 'error', 6000);
  }
}

// ---------------------------------------------------------------------------
// Export report
// ---------------------------------------------------------------------------
async function exportReport() {
  if (!state.standardId) {
    toast('Select a compliance standard first.', 'info');
    return;
  }
  const btn = $('#btn-export');
  btn.disabled = true;
  try {
    const res = await unwrap(window.api.exportReport(state.standardId));
    if (res.saved) toast('Report saved: ' + res.path, 'success', 6000);
    else toast('Export cancelled.', 'info');
  } catch (err) {
    toast('Export failed: ' + err.message, 'error', 6000);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------
const updateUI = { status: null, bar: null, wrap: null, downloadBtn: null, installBtn: null, githubLink: null };

function openUpdateModal() {
  const body = el('div');
  updateUI.status = el('p', {}, 'Checking for updates…');
  updateUI.wrap = el('div', { class: 'progress hidden' }, [(updateUI.bar = el('div', { class: 'progress-bar' }))]);
  updateUI.githubLink = el('p', { class: 'hidden' }, [
    el('a', { class: 'ref-link', href: 'https://github.com/trendlinepros-afk/Local-GPO-testing/releases', target: '_blank', rel: 'noopener', text: 'Open releases on GitHub ↗' })
  ]);
  body.appendChild(updateUI.status);
  body.appendChild(updateUI.wrap);
  body.appendChild(updateUI.githubLink);

  updateUI.downloadBtn = { label: 'Download update', class: 'btn-primary', id: 'upd-download', onClick: () => window.api.downloadUpdate() };
  updateUI.installBtn = { label: 'Restart & install', class: 'btn-primary', id: 'upd-install', onClick: () => window.api.installUpdate() };

  openModal('Software updates', body, [{ label: 'Close', class: 'btn-ghost', onClick: closeModal }]);
  window.api.checkForUpdates();
}

function setFootButtons(buttons) {
  const foot = $('#modal-foot');
  foot.innerHTML = '';
  for (const b of buttons) {
    const btn = el('button', { class: `btn ${b.class || 'btn-ghost'}`, type: 'button', text: b.label });
    btn.addEventListener('click', () => b.onClick && b.onClick());
    foot.appendChild(btn);
  }
}

function wireUpdaterEvents() {
  window.api.onUpdaterEvent((payload) => {
    const isUpdateModalOpen = !$('#modal-overlay').classList.contains('hidden') && $('#modal-title').textContent === 'Software updates';
    const { type, data } = payload;

    if (type === 'error') {
      if (isUpdateModalOpen && updateUI.status) updateUI.status.textContent = 'Update error: ' + (data && data.message);
      else toast('Update error: ' + (data && data.message), 'error', 6000);
      return;
    }
    if (!isUpdateModalOpen) {
      // Surface important transitions even if the modal was closed.
      if (type === 'available') toast(`Update available: v${data.version}`, 'info');
      if (type === 'downloaded') toast(`Update v${data.version} ready to install.`, 'success');
      return;
    }

    switch (type) {
      case 'checking':
        updateUI.status.textContent = 'Checking for updates…';
        break;
      case 'not-available':
        updateUI.status.textContent = '✔ You are running the latest version.';
        break;
      case 'available':
        if (data.manual) {
          updateUI.status.textContent = `Version ${data.version} is available on GitHub. Automatic install runs from the installed build; download it manually here:`;
          updateUI.githubLink.classList.remove('hidden');
        } else {
          updateUI.status.textContent = `Update available: v${data.version}. Download it now?`;
          setFootButtons([
            { label: 'Close', class: 'btn-ghost', onClick: closeModal },
            updateUI.downloadBtn
          ]);
        }
        break;
      case 'progress':
        updateUI.wrap.classList.remove('hidden');
        updateUI.bar.style.width = `${data.percent}%`;
        updateUI.status.textContent = `Downloading update… ${data.percent}%`;
        break;
      case 'downloaded':
        updateUI.wrap.classList.add('hidden');
        updateUI.status.textContent = `Update v${data.version} downloaded. Restart to install.`;
        setFootButtons([
          { label: 'Later', class: 'btn-ghost', onClick: closeModal },
          updateUI.installBtn
        ]);
        break;
      default:
        break;
    }
  });
}

document.addEventListener('DOMContentLoaded', init);

/**
 * Table to CSV - Popup Script
 * 检测页面表格 → 选择 → 预览 → 下载CSV
 */

const contentEl = document.getElementById('content');

// ---- SVG icons ----
const ICONS = {
  download: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  empty: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>`,
  check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
};

// ---- Main ----
async function main() {
  // 获取当前活动标签页
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return renderEmpty('无法获取当前标签页');

  // 特殊页面无法注入脚本
  if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
    return renderEmpty('浏览器内部页面不支持解析');
  }

  // 注入脚本，获取页面表格数据
  let tables;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractTables,
    });
    tables = results?.[0]?.result || [];
  } catch (e) {
    return renderEmpty('无法访问该页面内容');
  }

  if (!tables.length) return renderEmpty('页面中没有找到表格');

  // 只有一个表格 → 直接预览
  if (tables.length === 1) {
    renderPreview(tables, 0);
    return;
  }

  // 多个表格 → 先选择
  renderSelector(tables);
}

// ---- 单元格文本提取（多策略） ----
// 应对 innerText 为空的情况：图片、SVG、user-select:none、Canvas 等
function extractCellText(cell) {
  // 策略1: innerText（尊重 CSS 隐藏和 user-select）
  const inner = (cell.innerText || '').trim().replace(/\n+/g, ' ');
  if (inner) return inner;

  // 策略2: textContent（不尊重 CSS，但能拿到所有文本节点）
  const content = (cell.textContent || '').trim().replace(/\n+/g, ' ');
  if (content) return content;

  // 策略3: aria-label / title 属性（常用于无障碍的图标表头）
  const ariaLabel = cell.getAttribute('aria-label') || cell.getAttribute('title') || '';
  if (ariaLabel.trim()) return ariaLabel.trim();

  // 策略4: img 的 alt 文本
  const img = cell.querySelector('img');
  if (img) {
    const alt = (img.getAttribute('alt') || '').trim();
    if (alt) return alt;
  }

  // 策略5: SVG 的 title 或 aria-label
  const svg = cell.querySelector('svg');
  if (svg) {
    const svgTitle = svg.querySelector('title');
    if (svgTitle && svgTitle.textContent.trim()) return svgTitle.textContent.trim();
    const svgAria = svg.getAttribute('aria-label') || '';
    if (svgAria.trim()) return svgAria.trim();
  }

  return '';
}

// ---- Content script (注入到页面执行) ----
function extractTables() {
  const tableEls = document.querySelectorAll('table');
  const result = [];

  tableEls.forEach((table, idx) => {
    // 使用二维矩阵展开 colspan/rowspan，确保列对齐
    const allRows = table.querySelectorAll('tr');
    const matrix = []; // matrix[row][col] = text
    let maxCols = 0;

    allRows.forEach((tr, ri) => {
      // 确保矩阵有足够行
      while (matrix.length <= ri) matrix.push([]);

      const cells = tr.querySelectorAll('th, td');
      let colIdx = 0; // 当前应该写入的列位置

      cells.forEach(td => {
        // 跳过已被 rowspan 占据的列
        while (matrix[ri][colIdx] !== undefined) colIdx++;

        // 多策略提取单元格文本，应对不可复制/不可选中的内容
        const text = extractCellText(td);
        const cs = parseInt(td.getAttribute('colspan')) || 1;
        const rs = parseInt(td.getAttribute('rowspan')) || 1;

        // 将单元格文本填充到矩阵中
        for (let r = 0; r < rs; r++) {
          for (let c = 0; c < cs; c++) {
            const targetRow = ri + r;
            // 确保矩阵有足够行
            while (matrix.length <= targetRow) matrix.push([]);
            // 填充：合并区域只有左上角放文本，其余填空字符串
            matrix[targetRow][colIdx + c] = (r === 0 && c === 0) ? text : '';
          }
        }

        colIdx += cs;
      });

      maxCols = Math.max(maxCols, matrix[ri].length);
    });

    // 统一所有行的列数
    matrix.forEach(row => {
      while (row.length < maxCols) row.push('');
    });

    if (!matrix.length || !maxCols) return;

    // 判断表头：第一行如果全部是 th，或没有 th 时取第一行作为 header
    const firstRowCells = allRows[0]?.querySelectorAll('th, td') || [];
    const hasTh = allRows[0]?.querySelectorAll('th').length > 0;
    const hasThead = table.querySelector('thead') !== null;

    let headers, dataRows;

    if (hasTh || hasThead) {
      // 有明确的表头行，可能跨多行（多级表头）
      // 收集连续的 th 行作为表头
      let headerEndIdx = 0;
      allRows.forEach((tr, ri) => {
        if (tr.querySelectorAll('th').length > 0) {
          headerEndIdx = ri + 1;
        }
      });

      // 如果多行表头，合并为单行（用换行分隔多级表头内容）
      if (headerEndIdx > 1) {
        headers = [];
        for (let c = 0; c < maxCols; c++) {
          const parts = [];
          for (let r = 0; r < headerEndIdx; r++) {
            const val = matrix[r]?.[c] ?? '';
            if (val) parts.push(val);
          }
          headers.push(parts.join(' / '));
        }
      } else {
        headers = matrix[0] || [];
      }
      dataRows = matrix.slice(headerEndIdx);
    } else {
      // 没有 th，把第一行当 header
      headers = matrix[0] || [];
      dataRows = matrix.slice(1);
    }

    // 过滤空行
    dataRows = dataRows.filter(row => row.some(c => c !== ''));

    if (!headers.length && !dataRows.length) return;

    // 如果没有 header，生成默认列名
    if (!headers.length || headers.every(h => h === '')) {
      headers = dataRows[0]?.map((_, i) => `列${i + 1}`) || [];
    }

    // 获取预览文本
    const previewText = (dataRows[0] || headers).slice(0, 3).join(' | ');

    result.push({
      index: idx,
      rows: dataRows.length,
      cols: headers.length,
      headers,
      data: dataRows,
      previewText,
    });
  });

  return result;
}

// ---- Render: 空状态 ----
function renderEmpty(msg) {
  contentEl.innerHTML = `
    <div class="empty">
      ${ICONS.empty}
      <p>${msg}</p>
    </div>
  `;
}

// ---- Render: 表格选择器 ----
function renderSelector(tables) {
  const items = tables.map((t, i) => `
    <div class="table-item" data-idx="${i}">
      <div class="badge">${i + 1}</div>
      <div class="info">
        <div class="dim">${t.rows} 行 × ${t.cols} 列</div>
        <div class="preview-text">${escapeHtml(t.previewText)}</div>
      </div>
    </div>
  `).join('');

  contentEl.innerHTML = `
    <div class="selector-section">
      <label>检测到 ${tables.length} 个表格，请选择要解析的表格</label>
      <div class="table-list">${items}</div>
    </div>
  `;

  // 绑定点击
  contentEl.querySelectorAll('.table-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx, 10);
      renderPreview(tables, idx);
    });
  });
}

// ---- Render: 预览 + 下载 ----
function renderPreview(tables, selectedIdx) {
  const t = tables[selectedIdx];
  const MAX_PREVIEW_ROWS = 15;
  const showRows = t.data.slice(0, MAX_PREVIEW_ROWS);
  const hasMore = t.data.length > MAX_PREVIEW_ROWS;

  // 构建选择器（多表格时显示在顶部）
  let selectorHTML = '';
  if (tables.length > 1) {
    const chips = tables.map((_, i) => {
      const cls = i === selectedIdx ? 'table-item selected' : 'table-item';
      return `
        <div class="${cls}" data-idx="${i}" style="padding:8px 12px;">
          <div class="badge">${i + 1}</div>
          <div class="info">
            <div class="dim" style="font-size:12px;">${tables[i].rows}×${tables[i].cols}</div>
          </div>
          ${i === selectedIdx ? `<span style="color:#0071e3;">${ICONS.check}</span>` : ''}
        </div>
      `;
    }).join('');
    selectorHTML = `
      <div class="selector-section" style="padding-top:8px;">
        <div class="table-list" style="flex-direction:row;flex-wrap:wrap;gap:4px;">${chips}</div>
      </div>
    `;
  }

  // 构建预览表
  const thCells = t.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('');
  const trCells = showRows.map(row => {
    // 补齐列数
    const padded = [...row];
    while (padded.length < t.headers.length) padded.push('');
    const tdHTML = padded.map(c => `<td>${escapeHtml(c)}</td>`).join('');
    return `<tr>${tdHTML}</tr>`;
  }).join('');

  const moreHTML = hasMore ? `<div class="more-rows">还有 ${t.data.length - MAX_PREVIEW_ROWS} 行未显示</div>` : '';

  contentEl.innerHTML = `
    ${selectorHTML}
    <div class="preview-section">
      <div class="label">预览（${t.rows} 行 × ${t.cols} 列）</div>
      <div class="preview-table-wrapper">
        <table>
          <thead><tr>${thCells}</tr></thead>
          <tbody>${trCells}</tbody>
        </table>
        ${moreHTML}
      </div>
    </div>
    <div class="action-bar">
      <button class="btn-download" id="btn-download">
        ${ICONS.download}
        下载 CSV
      </button>
    </div>
  `;

  // 切换表格
  if (tables.length > 1) {
    contentEl.querySelectorAll('.table-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx, 10);
        if (idx !== selectedIdx) renderPreview(tables, idx);
      });
    });
  }

  // 下载
  document.getElementById('btn-download').addEventListener('click', () => {
    downloadCSV(t);
  });
}

// ---- CSV 生成与下载 ----
function downloadCSV(tableData) {
  const csvRows = [];

  // Header
  csvRows.push(tableData.headers.map(escapeCSV).join(','));

  // Data rows
  tableData.data.forEach(row => {
    const padded = [...row];
    while (padded.length < tableData.headers.length) padded.push('');
    csvRows.push(padded.map(escapeCSV).join(','));
  });

  const csvContent = '\uFEFF' + csvRows.join('\n'); // BOM for Excel中文
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `table_export_${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeCSV(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function escapeHtml(str) {
  const s = String(str ?? '');
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---- 启动 ----
main();

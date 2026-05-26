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

// ---- Content script (注入到页面执行) ----
// 注意：此函数通过 chrome.scripting.executeScript 注入，必须是自包含的，不能引用外部作用域
function extractTables() {
  // 内联：多策略单元格文本提取
  function extractCellText(cell) {
    // 策略0: 优先取 title div（Ant Design 等框架的表头结构：<div title="xxx">）
    const titleDiv = cell.querySelector('div[title]');
    if (titleDiv) {
      const titleAttr = titleDiv.getAttribute('title') || '';
      if (titleAttr.trim()) return titleAttr.trim();
    }

    // 策略1: innerText
    const inner = (cell.innerText || '').trim().replace(/\n+/g, ' ');
    if (inner) return inner;

    // 策略2: textContent（不尊重 CSS，但能拿到所有文本节点）
    const content = (cell.textContent || '').trim().replace(/\n+/g, ' ');
    if (content) return content;

    // 策略3: aria-label / title 属性
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

  // 解析单个 table 元素的行为矩阵
  // colspan/rowspan 合并单元格：被覆盖的格子也填充原始文本（而非空串）
  // 这样 CSV 导出时每行数据都是完整的，不会因 rowspan 导致部分列空缺
  function parseTableToMatrix(tableEl) {
    const allRows = tableEl.querySelectorAll('tr');
    const matrix = [];
    let maxCols = 0;

    allRows.forEach((tr) => {
      // 跳过 aria-hidden 行（Ant Design 测量行等）
      if (tr.getAttribute('aria-hidden') === 'true') return;

      const ri = matrix.length; // 用实际行索引，不是 DOM 行索引
      while (matrix.length <= ri) matrix.push([]);

      const cells = tr.querySelectorAll('th, td');
      let colIdx = 0;

      cells.forEach(td => {
        while (matrix[ri][colIdx] !== undefined) colIdx++;

        const text = extractCellText(td);
        const cs = parseInt(td.getAttribute('colspan')) || 1;
        const rs = parseInt(td.getAttribute('rowspan')) || 1;

        for (let r = 0; r < rs; r++) {
          for (let c = 0; c < cs; c++) {
            const targetRow = ri + r;
            while (matrix.length <= targetRow) matrix.push([]);
            // 合并区域所有格子都填原始文本，确保每行数据完整
            matrix[targetRow][colIdx + c] = text;
          }
        }

        colIdx += cs;
      });

      maxCols = Math.max(maxCols, matrix[ri]?.length || 0);
    });

    // 统一列数
    matrix.forEach(row => {
      while (row.length < maxCols) row.push('');
    });

    return { matrix, maxCols };
  }

  const tableEls = document.querySelectorAll('table');
  const result = [];
  const processedIndices = new Set();

  tableEls.forEach((table, idx) => {
    if (processedIndices.has(idx)) return;

    const hasThead = table.querySelector('thead') !== null;
    const hasTbody = table.querySelector('tbody') !== null;
    const hasTh = table.querySelectorAll('th').length > 0;
    const hasTd = table.querySelectorAll('td').length > 0;

    // 情况1：只有 thead 没有 tbody 的表格（React/Ant Design 等拆分表格）
    // 需要找到紧邻的只有 tbody 的 table 合并
    if (hasThead && !hasTbody) {
      // 解析表头
      const headResult = parseTableToMatrix(table);
      const headers = headResult.matrix;

      // 在 document.querySelectorAll('table') 列表中，body table 通常紧接在 head table 之后
      // 因为 nextElementSibling 只能找同层级兄弟，而 Ant Design 的 head/body 在不同 div 容器里
      let bodyTable = null;
      let bodyIdx = -1;

      // 策略1: 直接检查 idx+1 的 table（最常见：head/body 紧邻）
      for (let offset = 1; offset <= 3 && (idx + offset) < tableEls.length; offset++) {
        const candidate = tableEls[idx + offset];
        if (candidate.querySelector('tbody') && !candidate.querySelector('thead')) {
          bodyTable = candidate;
          bodyIdx = idx + offset;
          break;
        }
      }

      // 策略2: 如果 idx+1 没找到，用 DOM 树向上查找公共容器，再向下找 body table
      if (!bodyTable) {
        let container = table.parentElement;
        for (let depth = 0; depth < 5 && container; depth++) {
          const siblingContainer = container.nextElementSibling;
          if (siblingContainer) {
            const candidateTable = siblingContainer.querySelector('table');
            if (candidateTable && candidateTable.querySelector('tbody') && !candidateTable.querySelector('thead')) {
              const candidateIdx = Array.from(tableEls).indexOf(candidateTable);
              if (candidateIdx > idx) {
                bodyTable = candidateTable;
                bodyIdx = candidateIdx;
                break;
              }
            }
          }
          container = container.parentElement;
        }
      }

      if (bodyTable) {
        processedIndices.add(bodyIdx);
        const bodyResult = parseTableToMatrix(bodyTable);
        // 合并：表头 + 数据
        const combined = [...headers, ...bodyResult.matrix];
        const maxCols = Math.max(headResult.maxCols, bodyResult.maxCols);
        combined.forEach(row => {
          while (row.length < maxCols) row.push('');
        });

        addTableResult(result, idx, combined, true);
      } else {
        // 没找到 body table，只有表头
        addTableResult(result, idx, headers, true);
      }
      return;
    }

    // 情况2：只有 tbody 没有 thead 的表格
    // 如果紧跟在一个 head-only table 后面，已经被合并处理，跳过
    if (!hasThead && hasTbody && !hasTh) {
      // 检查前一个 table 是否是 head-only（在 tableEls 列表中紧邻）
      if (idx > 0) {
        const prevTable = tableEls[idx - 1];
        if (prevTable.querySelector('thead') && !prevTable.querySelector('tbody')) {
          // 已被 head table 合并处理，跳过
          return;
        }
      }
      // 独立的 body-only table，作为普通表格处理（第一行当表头）
    }

    // 情况3：普通完整表格（thead + tbody 都有，或只有 tr）
    const { matrix, maxCols } = parseTableToMatrix(table);
    if (!matrix.length || !maxCols) return;
    const hasHeader = hasTh || hasThead;
    addTableResult(result, idx, matrix, hasHeader);
  });

  function addTableResult(result, idx, matrix, hasHeader) {
    if (!matrix.length) return;
    const maxCols = Math.max(...matrix.map(r => r.length));
    matrix.forEach(row => { while (row.length < maxCols) row.push(''); });

    let headers, dataRows;

    if (hasHeader) {
      // 检测连续的表头行：如果多行表头（如 rowspan 的分组表头），
      // 合并为单行，用 " / " 连接多级内容
      let headerEndIdx = 1; // 默认第一行是表头

      // 检查是否有跨行表头：如果第二行中有格子已被第一行占位（值相同），
      // 说明第一行有 rowspan，属于多行表头
      if (matrix.length > 1) {
        // 更可靠的方式：如果第一行和第二行有相同值在同一列，
        // 且第一行该列的 td/th 有 rowspan>1，则属于多行表头
        // 简化：如果第二行大部分值和第一行相同（被 rowspan 填充），则视为多行表头
        const row1 = matrix[0];
        const row2 = matrix[1];
        let sameCount = 0;
        for (let c = 0; c < maxCols; c++) {
          if (row1[c] === row2[c] && row1[c] !== '') sameCount++;
        }
        if (sameCount > maxCols * 0.5) {
          headerEndIdx = 2; // 两行表头
        }
      }

      if (headerEndIdx > 1) {
        // 合并多行表头：每列取所有表头行中非空的值，用 " / " 连接
        headers = [];
        for (let c = 0; c < maxCols; c++) {
          const parts = [];
          for (let r = 0; r < headerEndIdx; r++) {
            const val = matrix[r]?.[c] ?? '';
            // 去重：同一列如果多行值相同（被 rowspan 填充），只取一次
            if (val && (!parts.length || parts[parts.length - 1] !== val)) {
              parts.push(val);
            }
          }
          headers.push(parts.join(' / '));
        }
      } else {
        headers = matrix[0] || [];
      }
      dataRows = matrix.slice(headerEndIdx);
    } else {
      headers = matrix[0] || [];
      dataRows = matrix.slice(1);
    }

    // 过滤空行（所有列都为空字符串的行）
    dataRows = dataRows.filter(row => row.some(c => c !== ''));

    if (!headers.length && !dataRows.length) return;

    if (!headers.length || headers.every(h => h === '')) {
      headers = dataRows[0]?.map((_, i) => `列${i + 1}`) || [];
    }

    const previewText = (dataRows[0] || headers).slice(0, 3).join(' | ');

    result.push({
      index: idx,
      rows: dataRows.length,
      cols: headers.length,
      headers,
      data: dataRows,
      previewText,
    });
  }

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

// ========== Notion Local Bridge — inline Save buttons (overlay) ==========
// Чтение кода учитывает построчный рендер Notion (каждая строка — отдельный
// flex-row с gutter’ом номера слева и ячейкой <code> справа). Код собирается
// построчно + прокрутка для виртуализованных длинных файлов.

// ========== MESSAGE LISTENER (совместимость с popup) ==========
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'insert_prompt') {
        insertTextIntoNotion(request.prompt);
        sendResponse({ success: true });
    }
});

function insertTextIntoNotion(text) {
    const editable = document.querySelector('[contenteditable="true"]');
    if (editable) {
        editable.focus();
        document.execCommand('insertText', false, text);
    } else {
        alert('Notion Local Bridge: Не удалось найти поле ввода чата.');
    }
}

// ========== HELPERS ==========
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeText(text) {
    return (text || '')
        .replace(/[\u200B\uFEFF]/g, '')
        .replace(/[\u00A0\u202F]/g, ' ')
        .replace(/\r\n?/g, '\n')
        .trim();
}

function isMonospace(cs) {
    const ff = (cs.fontFamily || '').toLowerCase();
    return ff.includes('mono') || ff.includes('consolas') ||
        ff.includes('menlo') || ff.includes('courier');
}

function extractFilename(text) {
    if (!text) return '';
    const matches = text.match(/[\w\-./]+\.[A-Za-z0-9]{1,10}/g);
    if (!matches || matches.length === 0) return '';
    const exts = /\.(py|js|ts|jsx|tsx|json|html|htm|css|scss|md|txt|java|c|cpp|h|hpp|cs|go|rs|rb|php|sh|yml|yaml|xml|sql|kt|swift|vue|toml|ini|cfg|env|gitignore|dockerfile)$/i;
    const good = matches.filter(m => exts.test(m));
    const pool = good.length ? good : matches;
    pool.sort((a, b) => a.length - b.length);
    return pool[0];
}

function detectCodeFilename(anchor, codeText) {
    let filename = '';
    const firstLine = (codeText.split('\n')[0] || '').trim();
    const commentMatch = firstLine.match(/^(?:\/\/|#|--|\/\*|<!--)\s*([\w./\-\\]+\.\w+)/);
    if (commentMatch) filename = commentMatch[1];

    if (!filename && anchor) {
        let node = anchor;
        for (let i = 0; i < 5 && node; i++) {
            const prev = node.previousElementSibling;
            if (prev) {
                const prevText = (prev.innerText || '').trim();
                const fileMatch = prevText.match(/([\w./\-]+\.\w{1,10})/);
                if (fileMatch) { filename = fileMatch[1]; break; }
            }
            node = node.parentElement;
        }
    }
    return filename;
}

// ========== ПОСТРОЧНЫЙ РЕНДЕР: сборка кода из gutter-строк ==========

// gutter = ячейка номера строки (aria-hidden, число, inline font-family: monospace).
function isGutter(g) {
    if (!g || !g.getAttribute || g.getAttribute('aria-hidden') !== 'true') return false;
    const t = (g.textContent || '').trim();
    if (!/^\d+$/.test(t)) return false;
    const ff = (g.style && g.style.fontFamily ? g.style.fontFamily : '').toLowerCase();
    return ff.includes('mono');
}

// Контейнеры со строками кода -> кол-во строк.
function bodiesWithCounts() {
    const map = new Map();
    const gutters = document.querySelectorAll('div[aria-hidden="true"]');
    gutters.forEach(g => {
        if (!isGutter(g)) return;
        const row = g.parentElement;
        if (!row) return;
        const body = row.parentElement;
        if (!body) return;
        map.set(body, (map.get(body) || 0) + 1);
    });
    return map;
}

function findScrollParent(el) {
    let node = el ? el.parentElement : null;
    while (node && node !== document.body) {
        let cs;
        try { cs = getComputedStyle(node); } catch (e) { break; }
        if (cs) {
            const oy = cs.overflowY, o = cs.overflow;
            if ((oy === 'auto' || oy === 'scroll' || o === 'auto' || o === 'scroll') &&
                node.scrollHeight > node.clientHeight + 4) {
                return node;
            }
        }
        node = node.parentElement;
    }
    return (el && el.parentElement) || el;
}

// Собираем видимые сейчас строки: номер -> текст.
function harvestRows(body, lineMap) {
    const rows = body.children;
    for (let r = 0; r < rows.length; r++) {
        const cells = rows[r].children;
        if (!cells || cells.length === 0) continue;
        let gutter = null, codeCell = null;
        for (let c = 0; c < cells.length; c++) {
            const cell = cells[c];
            if (cell.getAttribute && cell.getAttribute('aria-hidden') === 'true') gutter = cell;
            else codeCell = cell;
        }
        if (!gutter) continue;
        const num = parseInt((gutter.textContent || '').trim(), 10);
        if (isNaN(num)) continue;
        lineMap.set(num, codeCell ? (codeCell.textContent || '') : '');
    }
}

// Прокручиваем контейнер сверху вниз и собираем ВСЕ строки (лечит виртуализацию).
async function collectAllLines(scrollEl, body) {
    const lineMap = new Map();
    const canScroll = scrollEl && scrollEl.scrollHeight > scrollEl.clientHeight + 4;
    const originalTop = scrollEl ? scrollEl.scrollTop : 0;

    if (canScroll) {
        scrollEl.scrollTop = 0;
        await wait(120);
        let guard = 0;
        while (guard++ < 2000) {
            harvestRows(body, lineMap);
            if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2) {
                await wait(80);
                harvestRows(body, lineMap);
                break;
            }
            scrollEl.scrollTop += Math.max(60, scrollEl.clientHeight * 0.8);
            await wait(70);
        }
        try { scrollEl.scrollTop = originalTop; } catch (e) { /* ignore */ }
    } else {
        harvestRows(body, lineMap);
    }

    if (lineMap.size === 0) return '';
    const nums = Array.from(lineMap.keys()).sort((a, b) => a - b);
    const min = nums[0], max = nums[nums.length - 1];
    const lines = [];
    for (let i = min; i <= max; i++) lines.push(lineMap.has(i) ? lineMap.get(i) : '');
    return normalizeText(lines.join('\n'));
}

// ========== SAVE ==========
function resetButton(btn) {
    btn.textContent = 'Save';
    btn.classList.remove('nlb-done', 'nlb-err');
    btn.disabled = false;
}

function failButton(btn, msg) {
    btn.textContent = 'Err';
    btn.classList.remove('nlb-done');
    btn.classList.add('nlb-err');
    btn.disabled = false;
    if (msg) alert(msg);
    setTimeout(() => resetButton(btn), 2500);
}

function saveToServer(filename, content, btn) {
    btn.textContent = '...';
    btn.disabled = true;
    btn.classList.remove('nlb-done', 'nlb-err');

    chrome.runtime.sendMessage({ action: 'save_file', filename, content }, (response) => {
        if (chrome.runtime.lastError) {
            failButton(btn, 'Error: ' + chrome.runtime.lastError.message);
        } else if (response && response.success) {
            btn.textContent = 'Saved';
            btn.classList.add('nlb-done');
            btn.disabled = false;
            setTimeout(() => resetButton(btn), 2500);
        } else {
            failButton(btn, 'Error: ' + (response ? response.error : 'Server not running?'));
        }
    });
}

async function handleSaveCode(target, btn) {
    btn.textContent = '...';
    btn.disabled = true;
    btn.classList.remove('nlb-done', 'nlb-err');

    let text = '';
    if (target.kind === 'gutter') {
        const scrollEl = findScrollParent(target.readEl);
        text = await collectAllLines(scrollEl, target.readEl);
    } else {
        const codeEl = target.readEl.querySelector('code') || target.readEl;
        text = normalizeText(codeEl.innerText || codeEl.textContent || '');
    }

    if (!text) {
        failButton(btn, 'Блок кода пуст (не удалось вычитать код).');
        return;
    }

    let filename = detectCodeFilename(target.posEl, text);
    if (!filename) filename = prompt('Имя файла (например, app.py):', '');
    if (!filename) { resetButton(btn); return; }

    saveToServer(filename, text, btn);
}

// Карточка: клик -> ждём НОВЫЙ контейнер со строками -> собираем код.
async function handleSaveFileCard(card, filename, btn) {
    btn.textContent = '...';
    btn.disabled = true;
    btn.classList.remove('nlb-done', 'nlb-err');

    const before = new Set(bodiesWithCounts().keys());
    card.click();

    let body = null;
    for (let i = 0; i < 45 && !body; i++) {
        await wait(200);
        const counts = bodiesWithCounts();
        // Предпочитаем НОВЫЙ контейнер (только что открывшаяся панель).
        let fresh = [];
        counts.forEach((n, b) => { if (!before.has(b)) fresh.push([b, n]); });
        if (fresh.length) {
            fresh.sort((a, b) => b[1] - a[1]);
            body = fresh[0][0];
        }
    }

    // Фолбэк: панель могла переиспользовать контейнер — берём самый большой.
    if (!body) {
        const counts = bodiesWithCounts();
        let bestN = 0;
        counts.forEach((n, b) => { if (n > bestN) { bestN = n; body = b; } });
    }

    if (!body) {
        failButton(
            btn,
            'Не удалось открыть панель с кодом.\n\n' +
            'Надёжный способ: откройте файл и нажмите Save на самом блоке кода.'
        );
        return;
    }

    const scrollEl = findScrollParent(body);
    const text = await collectAllLines(scrollEl, body);
    if (!text) {
        failButton(btn, 'Код в панели пуст или не вычитался.');
        return;
    }
    saveToServer(filename, text, btn);
}

// ========== TARGET DETECTION ==========
function isCodeLike(el) {
    const text = (el.innerText || '').trim();
    if (text.length < 10) return false;
    if (el.clientHeight < 35) return false; // отсекает отдельные строки (~18px)

    let cs;
    try { cs = window.getComputedStyle(el); } catch (e) { return false; }
    if (!cs || cs.display === 'inline') return false;

    if (el.matches('pre, .notion-code-block')) return true;

    if (!isMonospace(cs)) return false;
    const ws = cs.whiteSpace;
    if (ws !== 'pre' && ws !== 'pre-wrap') return false;
    return true;
}

function getFileCards() {
    const cards = [];
    const seen = new Set();
    const svgs = document.querySelectorAll('svg.code');
    for (const svg of svgs) {
        const card = svg.closest('div[role="button"]');
        if (!card || seen.has(card)) continue;
        seen.add(card);
        const filename = extractFilename(card.textContent || '');
        if (filename) cards.push({ el: card, filename });
    }
    return cards;
}

function getTargets() {
    const targets = [];
    const usedBodies = [];

    // Кнопка Save рисуется ТОЛЬКО над блоками кода (в чате и в открытой панели),
    // потому что над файловой карточкой код недоступен без открытия превью.
    // 1. Построчные код-блоки (gutter с номерами строк) — и в чате, и в панели.
    const counts = bodiesWithCounts();
    counts.forEach((n, body) => {
        if (n < 1) return;
        const scrollEl = findScrollParent(body);
        targets.push({ type: 'code', kind: 'gutter', posEl: scrollEl || body, readEl: body });
        usedBodies.push(body);
    });

    // 2. Обычные блоки кода без номеров строк.
    const codeSet = new Set();
    document.querySelectorAll('pre, .notion-code-block').forEach(el => { if (isCodeLike(el)) codeSet.add(el); });
    let codeEls = Array.from(codeSet).filter(el => !Array.from(codeSet).some(o => o !== el && o.contains(el)));
    codeEls.forEach(el => {
        if (usedBodies.some(b => b.contains(el) || el.contains(b))) return;
        targets.push({ type: 'code', kind: 'plain', posEl: el, readEl: el });
    });

    return targets;
}

// ========== OVERLAY BUTTONS ==========
const overlay = document.createElement('div');
overlay.id = 'nlb-overlay';

const buttons = new Map(); // posEl -> button

function createButton(target) {
    const btn = document.createElement('button');
    btn.className = 'nlb-save-btn';
    btn.textContent = 'Save';

    if (target.type === 'filecard') {
        btn.title = 'Сохранить ' + target.filename;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleSaveFileCard(target.posEl, target.filename, btn);
        });
    } else {
        btn.title = 'Сохранить в локальный проект';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleSaveCode(target, btn);
        });
    }
    return btn;
}

function positionButton(btn, el) {
    const r = el.getBoundingClientRect();
    const offscreen =
        r.width < 1 || r.height < 1 ||
        r.bottom < 0 || r.top > window.innerHeight ||
        r.right < 0 || r.left > window.innerWidth;
    if (offscreen) {
        btn.style.display = 'none';
        return;
    }
    btn.style.display = 'block';
    const bw = btn.offsetWidth || 52;
    // Для больших панелей держим кнопку у верхней видимой кромки.
    const top = Math.max(r.top + 6, 56);
    btn.style.top = top + 'px';
    btn.style.left = (r.right - bw - 12) + 'px';
}

function updateButtons() {
    const targets = getTargets();
    const liveEls = new Set(targets.map(t => t.posEl));

    for (const [el, btn] of buttons) {
        if (!liveEls.has(el) || !document.contains(el)) {
            btn.remove();
            buttons.delete(el);
        }
    }

    targets.forEach((target) => {
        let btn = buttons.get(target.posEl);
        if (!btn) {
            btn = createButton(target);
            overlay.appendChild(btn);
            buttons.set(target.posEl, btn);
        }
        positionButton(btn, target.posEl);
    });
}

function repositionAll() {
    for (const [el, btn] of buttons) {
        if (document.contains(el)) positionButton(btn, el);
    }
}

// ========== INIT ==========
function init() {
    document.body.appendChild(overlay);
    updateButtons();
    setInterval(updateButtons, 500);
    window.addEventListener('scroll', repositionAll, true);
    window.addEventListener('resize', repositionAll);
}

if (document.body) {
    setTimeout(init, 1200);
} else {
    window.addEventListener('DOMContentLoaded', () => setTimeout(init, 1200));
}
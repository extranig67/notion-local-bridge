// extension/popup.js
const SERVER_URL = 'http://127.0.0.1:5050';

document.addEventListener('DOMContentLoaded', async () => {
    const btnLoad = document.getElementById('btn-load');
    const btnBrowse = document.getElementById('btn-browse');
    const btnSend = document.getElementById('btn-send');
    const btnRefresh = document.getElementById('btn-refresh');
    const selectAll = document.getElementById('select-all');
    const inputDir = document.getElementById('project-dir');
    const treeDiv = document.getElementById('file-tree');
    const statusDiv = document.getElementById('status');
    const fileCount = document.getElementById('file-count');
    const connDot = document.getElementById('conn-dot');
    const connText = document.getElementById('conn-text');

    function setStatus(msg, type = 'info') {
        statusDiv.textContent = msg;
        statusDiv.className = type;
    }

    function setConn(state, text) {
        if (connDot) {
            connDot.className = 'conn-dot conn-dot--' + state;
        }
        if (connText) {
            connText.textContent = text;
        }
    }

    // --- Connection indicator (popup can fetch localhost directly) ---
    async function checkHealth() {
        setConn('unknown', 'Проверка соединения…');
        try {
            const res = await fetch(`${SERVER_URL}/api/health`);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            if (data && data.status === 'ok') {
                if (data.project_dir_exists === false) {
                    setConn('warn', 'Сервер онлайн, папка не найдена');
                } else {
                    setConn('ok', 'Сервер подключён (v' + (data.version || '?') + ')');
                }
                return true;
            }
            throw new Error('bad response');
        } catch (e) {
            setConn('error', 'Сервер не запущен (порт 5050)');
            return false;
        }
    }

    function getCheckboxes() {
        return treeDiv.querySelectorAll('input[type="checkbox"]');
    }

    async function loadFiles() {
        const dir = inputDir.value.trim();
        if (!dir) return;

        btnLoad.disabled = true;
        setStatus('Загрузка...');

        try {
            await fetch(`${SERVER_URL}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ project_dir: dir })
            });

            const res = await fetch(`${SERVER_URL}/api/files`);
            if (!res.ok) throw new Error('Не удалось загрузить файлы');
            const data = await res.json();

            treeDiv.innerHTML = '';
            if (!data.files || data.files.length === 0) {
                treeDiv.innerHTML = '<div class="tree-empty">Файлы не найдены.</div>';
                btnSend.disabled = true;
                if (fileCount) fileCount.textContent = '';
            } else {
                data.files.forEach(file => {
                    const label = document.createElement('label');
                    label.className = 'file-item';
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.value = file;
                    label.appendChild(cb);
                    label.appendChild(document.createTextNode(file));
                    treeDiv.appendChild(label);
                });
                btnSend.disabled = false;
                if (fileCount) fileCount.textContent = `(${data.files.length})`;
            }
            if (selectAll) selectAll.checked = false;
            setStatus(`Загружено ${data.files ? data.files.length : 0} файлов.`, 'success');
        } catch (e) {
            setStatus('Ошибка: ' + e.message, 'error');
        } finally {
            btnLoad.disabled = false;
        }
    }

    // --- Нативный выбор папки (проводник/Finder через сервер) ---
    async function browseFolder() {
        btnBrowse.disabled = true;
        const prev = statusDiv.textContent;
        setStatus('Открываю выбор папки…');
        try {
            const res = await fetch(`${SERVER_URL}/api/pick-folder`, { method: 'POST' });
            const data = await res.json();
            if (data.status === 'ok' && data.project_dir) {
                inputDir.value = data.project_dir;
                setStatus('Папка выбрана.', 'success');
                await loadFiles();
            } else if (data.status === 'cancelled') {
                setStatus(prev || 'Выбор папки отменён.');
            } else {
                setStatus('Ошибка: ' + (data.error || 'не удалось выбрать папку'), 'error');
            }
        } catch (e) {
            setStatus('Ошибка: сервер не запущен? (порт 5050)', 'error');
        } finally {
            btnBrowse.disabled = false;
        }
    }

    // Initial connection check + config load
    const online = await checkHealth();
    if (online) {
        try {
            const res = await fetch(`${SERVER_URL}/api/config`);
            if (res.ok) {
                const data = await res.json();
                inputDir.value = data.project_dir || '';
                if (data.project_dir) loadFiles();
            }
        } catch (e) {
            setStatus('Убедитесь что Python-сервер запущен на порту 5050', 'error');
        }
    } else {
        setStatus('Убедитесь что Python-сервер запущен на порту 5050', 'error');
    }

    btnLoad.addEventListener('click', loadFiles);
    if (btnBrowse) btnBrowse.addEventListener('click', browseFolder);
    if (btnRefresh) btnRefresh.addEventListener('click', async () => {
        await checkHealth();
        loadFiles();
    });

    if (selectAll) {
        selectAll.addEventListener('change', () => {
            getCheckboxes().forEach(cb => { cb.checked = selectAll.checked; });
        });
    }

    btnSend.addEventListener('click', async () => {
        const checkboxes = treeDiv.querySelectorAll('input[type="checkbox"]:checked');
        const selectedFiles = Array.from(checkboxes).map(cb => cb.value);

        if (selectedFiles.length === 0) {
            setStatus('Выберите хотя бы один файл.', 'error');
            return;
        }

        btnSend.disabled = true;
        setStatus('Чтение файлов...');

        try {
            const res = await fetch(`${SERVER_URL}/api/file/read`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ files: selectedFiles })
            });

            if (!res.ok) throw new Error('Не удалось прочитать файлы');
            const data = await res.json();

            let promptText = 'Пожалуйста, отредактируй следующие файлы. Отправь мне результат НЕ в виде текста или блоков кода, а прикрепи ИМЕННО СКАЧИВАЕМЫЕ ФАЙЛЫ с теми же оригинальными названиями и расширениями. В САМОЙ ПЕРВОЙ СТРОКЕ каждого файла добавь комментарий с его ПОЛНЫМ относительным путём включая папки (например: // extension/content.js или # server/app.py), чтобы файл сохранился в правильную папку. ИСКЛЮЧЕНИЕ — файлы .html и .json: в них НЕ добавляй строку-комментарий (HTML требует <!DOCTYPE html> первой строкой, а JSON вообще не допускает комментарии). Вместо этого укажи ПОЛНЫЙ относительный путь прямо в ИМЕНИ файла (например: extension/popup.html или extension/manifest.json).\n\n';
            data.files.forEach(f => {
                if (f.error) {
                    promptText += '// ERROR reading ' + f.filename + ': ' + f.error + '\n\n';
                } else {
                    promptText += 'File: ' + f.filename + '\n`\n' + f.content + '\n`\n\n';
                }
            });

            await navigator.clipboard.writeText(promptText);
            setStatus('Скопировано! Вставьте в чат Notion (Cmd+V)', 'success');
        } catch (e) {
            setStatus('Ошибка: ' + e.message, 'error');
        } finally {
            btnSend.disabled = false;
        }
    });
});
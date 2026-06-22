// extension/background.js
const SERVER_URL = 'http://127.0.0.1:5050';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // --- Health check (альтернативный путь проверки связи) ---
    if (request.action === 'ping') {
        fetch(`${SERVER_URL}/api/health`, { method: 'GET' })
            .then(async (response) => {
                let data = null;
                try { data = await response.json(); } catch (e) { data = null; }
                if (response.ok && data && data.status === 'ok') {
                    sendResponse({ success: true, info: data });
                } else {
                    sendResponse({ success: false, error: `Server responded with ${response.status}` });
                }
            })
            .catch((error) => sendResponse({ success: false, error: error.toString() }));
        return true;
    }

    // --- Скачивание текста по URL (фолбэк для вложений) ---
    if (request.action === 'download_file') {
        fetch(request.url)
            .then(res => {
                if (!res.ok) throw new Error('HTTP Error ' + res.status);
                return res.text();
            })
            .then(text => sendResponse({ success: true, content: text }))
            .catch(err => sendResponse({ success: false, error: err.toString() }));
        return true;
    }

    // --- Сохранение файла на локальный сервер ---
    if (request.action === 'save_file') {
        // fetch в service worker обходит жёсткий CSP notion.so
        fetch(`${SERVER_URL}/api/file/write`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: request.filename,
                content: request.content
            })
        })
            .then(async (response) => {
                let data = null;
                try { data = await response.json(); } catch (e) { data = null; }

                if (response.ok && data && data.status === 'ok') {
                    sendResponse({ success: true });
                } else {
                    const error = (data && data.error) || `Server responded with ${response.status}`;
                    sendResponse({ success: false, error });
                }
            })
            .catch((error) => {
                sendResponse({ success: false, error: error.toString() });
            });

        return true; // async response
    }

    return false;
});
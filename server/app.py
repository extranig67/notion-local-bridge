# server/app.py
import os
import sys
import subprocess

from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)

# CORS остаётся открытым: запросы идут из service worker расширения
# (origin = chrome-extension://...), поэтому сужать до notion.so нельзя.
CORS(app)

# Текущая директория проекта, с которой мы работаем
PROJECT_DIR = os.path.expanduser("~/PyCharmMiscProject")


def _safe_path(filename):
    """Возвращает абсолютный путь внутри PROJECT_DIR или None.

    Поддерживает вложенные пути вида ``extension/content.js`` —
    промежуточные папки создаются при записи.
    """
    # Нормализуем разделители (Notion может отдать путь с "/").
    filename = (filename or '').replace('\\', '/').lstrip('/')
    base = os.path.realpath(PROJECT_DIR)
    target = os.path.realpath(os.path.join(base, filename))
    if target == base or target.startswith(base + os.sep):
        return target
    return None


def _pick_folder_tk(initial=None):
    """Фолбэк: tkinter в отдельном процессе (свой main-thread)."""
    code = (
        "import tkinter as tk\n"
        "from tkinter import filedialog\n"
        "r = tk.Tk(); r.withdraw(); r.attributes('-topmost', True)\n"
        "p = filedialog.askdirectory(title='Выберите папку проекта')\n"
        "import sys; sys.stdout.write(p or '')\n"
    )
    try:
        out = subprocess.run(
            [sys.executable, '-c', code],
            capture_output=True, text=True, timeout=180,
        )
        if out.returncode == 0:
            return out.stdout.strip() or None
    except Exception:
        pass
    return None


def _pick_folder_dialog(initial=None):
    """Открывает НАТИВНЫЙ диалог выбора папки; возвращает путь или None."""
    plat = sys.platform
    try:
        if plat == 'darwin':
            # macOS: нативный Finder-диалог через AppleScript.
            script = (
                'POSIX path of (choose folder with prompt '
                '"Выберите папку проекта Notion Local Bridge")'
            )
            out = subprocess.run(
                ['osascript', '-e', script],
                capture_output=True, text=True, timeout=180,
            )
            if out.returncode == 0:
                return out.stdout.strip() or None
            return None  # пользователь отменил
        if plat.startswith('win'):
            # Windows: FolderBrowserDialog через PowerShell.
            ps = (
                "Add-Type -AssemblyName System.Windows.Forms;"
                "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
                "$d.Description = 'Выберите папку проекта';"
                "if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK)"
                "{[Console]::Out.Write($d.SelectedPath)}"
            )
            out = subprocess.run(
                ['powershell', '-NoProfile', '-Command', ps],
                capture_output=True, text=True, timeout=180,
            )
            if out.returncode == 0:
                return out.stdout.strip() or None
            return None
        # Linux/другое: zenity → kdialog → tkinter
        for cmd in (
            ['zenity', '--file-selection', '--directory',
             '--title=Выберите папку проекта'],
            ['kdialog', '--getexistingdirectory',
             initial or os.path.expanduser('~')],
        ):
            try:
                out = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
                if out.returncode == 0:
                    return out.stdout.strip() or None
            except FileNotFoundError:
                continue
        return _pick_folder_tk(initial)
    except subprocess.TimeoutExpired:
        return None
    except Exception:
        return None


@app.route('/api/health', methods=['GET'])
def health():
    """Health-check: используется расширением для индикатора связи."""
    return jsonify({
        'status': 'ok',
        'service': 'Notion Local Bridge',
        'version': '1.4',
        'project_dir': PROJECT_DIR,
        'project_dir_exists': os.path.isdir(PROJECT_DIR),
    })


@app.route('/api/config', methods=['GET', 'POST'])
def config():
    global PROJECT_DIR
    if request.method == 'POST':
        data = request.get_json(silent=True)
        if not data or 'project_dir' not in data:
            return jsonify({'error': 'project_dir is required'}), 400

        new_dir = os.path.expanduser(data['project_dir'])
        if not os.path.isdir(new_dir):
            return jsonify({'error': f'Directory not found: {new_dir}'}), 404

        PROJECT_DIR = new_dir
        return jsonify({'status': 'ok', 'project_dir': PROJECT_DIR})

    return jsonify({'project_dir': PROJECT_DIR})


@app.route('/api/pick-folder', methods=['POST', 'GET'])
def pick_folder():
    """Открывает системный проводник/Finder для выбора папки проекта.

    Диалог открывается на машине, где запущен сервер (у пользователя).
    """
    global PROJECT_DIR
    chosen = _pick_folder_dialog(initial=PROJECT_DIR)
    if not chosen:
        return jsonify({'status': 'cancelled'}), 200
    if not os.path.isdir(chosen):
        return jsonify({'error': f'Directory not found: {chosen}'}), 404
    PROJECT_DIR = chosen
    return jsonify({'status': 'ok', 'project_dir': PROJECT_DIR})


@app.route('/api/files', methods=['GET'])
def list_files():
    """Возвращает дерево файлов проекта (пропуская скрытые папки)"""
    if not os.path.isdir(PROJECT_DIR):
        return jsonify({'error': 'Project directory not found'}), 404

    result = []
    ignore_dirs = {'.git', '.idea', '__pycache__', 'node_modules', '.venv', 'venv', 'notion-local-bridge'}

    for root, dirs, files in os.walk(PROJECT_DIR):
        # Исключаем ненужные папки
        dirs[:] = [d for d in dirs if d not in ignore_dirs]

        rel_path = os.path.relpath(root, PROJECT_DIR)
        if rel_path == '.':
            rel_path = ''

        for file in files:
            if file.startswith('.'):
                continue

            file_rel_path = os.path.join(rel_path, file)
            # Нормализуем слеши для Windows/Mac
            file_rel_path = file_rel_path.replace('\\', '/')

            result.append(file_rel_path)

    return jsonify({'files': sorted(result)})


@app.route('/api/file/read', methods=['POST'])
def read_files():
    """Читает содержимое запрошенных файлов"""
    data = request.get_json(silent=True)
    if not data or 'files' not in data:
        return jsonify({'error': 'files list is required'}), 400

    files_data = []
    for filepath in data['files']:
        safe_path = _safe_path(filepath)
        if not safe_path:
            files_data.append({'filename': filepath, 'error': 'Access denied'})
            continue

        try:
            with open(safe_path, 'r', encoding='utf-8') as f:
                content = f.read()
            files_data.append({'filename': filepath, 'content': content})
        except Exception as e:
            files_data.append({'filename': filepath, 'error': str(e)})

    return jsonify({'files': files_data})


@app.route('/api/file/write', methods=['POST'])
def write_file():
    """Перезаписывает файл (создавая вложенные папки при необходимости)"""
    data = request.get_json(silent=True)
    if not data or 'filename' not in data or 'content' not in data:
        return jsonify({'error': 'filename and content are required'}), 400

    filepath = data['filename']
    content = data['content']

    safe_path = _safe_path(filepath)
    if not safe_path:
        return jsonify({'error': 'Access denied'}), 403

    try:
        parent = os.path.dirname(safe_path)
        if parent:
            os.makedirs(parent, exist_ok=True)

        with open(safe_path, 'w', encoding='utf-8', newline='') as f:
            f.write(content)
        return jsonify({'status': 'ok', 'message': f'Saved {filepath}'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    print("Starting Local Bridge Server on http://127.0.0.1:5050")
    print("Health check: http://127.0.0.1:5050/api/health")
    print(f"Current Project Directory: {PROJECT_DIR}")
    app.run(host='127.0.0.1', port=5050, debug=False)
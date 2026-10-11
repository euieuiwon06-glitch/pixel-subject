@echo off
cd /d "%~dp0legacy"
start "" http://127.0.0.1:8766/prototype.html
python -m http.server 8766 --bind 127.0.0.1

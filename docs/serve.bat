@echo off
REM AIAG dashboard — one-click local server (enables pretty .md rendering + robust routing).
REM Serves the docs/ folder so DASHBOARD.html can fetch+render markdown (file:// can't).
cd /d "%~dp0"
echo Starting AIAG dashboard at http://localhost:8000/DASHBOARD.html
start "" "http://localhost:8000/DASHBOARD.html"
py -3 -m http.server 8000 2>nul || python -m http.server 8000

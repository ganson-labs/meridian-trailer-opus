@echo off
rem MERIDIAN - realtime trailer launcher.
rem Opens the trailer fullscreen in Chrome (or Edge) with its own profile so that
rem autoplay of the synthesized soundtrack and the fast OpenGL shader backend are allowed.
setlocal
set "HERE=%~dp0"
set "URL=file:///%HERE:\=/%index.html"
set "URL=%URL: =%%20%"
set "PROFILE=%LOCALAPPDATA%\MeridianTrailer\browser-profile"
set "BROWSER="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do if not defined BROWSER if exist %%P set "BROWSER=%%~P"
if not defined BROWSER (
  echo Chrome or Edge not found. Open index.html in a Chromium browser manually.
  exit /b 1
)
start "" "%BROWSER%" --user-data-dir="%PROFILE%" --kiosk --no-first-run --no-default-browser-check ^
  --autoplay-policy=no-user-gesture-required --use-angle=gl --ignore-gpu-blocklist ^
  --disable-features=Translate,MediaRouter --disable-session-crashed-bubble --hide-crash-restore-bubble ^
  "%URL%"
endlocal

@echo off
setlocal EnableExtensions EnableDelayedExpansion

chcp 65001 >nul
title Sala de Tela
cd /d "%~dp0"

set "NODE_CMD="
set "NPM_CMD="
set "NODE_MAJOR="
set "SYSTEM_NODE="
set "SYSTEM_NPM="
set "PORTABLE_NODE=%~dp0.cache\node-runtime\node.exe"
set "PORTABLE_NPM=%~dp0.cache\node-runtime\npm.cmd"

echo.
echo   Sala de Tela
echo   =============
echo.
echo   Verificando o Node.js...

where node.exe >nul 2>nul
if not errorlevel 1 (
  where npm.cmd >nul 2>nul
  if not errorlevel 1 (
    for /f "delims=" %%P in ('where node.exe 2^>nul') do if not defined SYSTEM_NODE set "SYSTEM_NODE=%%P"
    for /f "delims=" %%P in ('where npm.cmd 2^>nul') do if not defined SYSTEM_NPM set "SYSTEM_NPM=%%P"
    for /f "delims=" %%V in ('node.exe -p "Number(process.versions.node.split('.')[0])" 2^>nul') do set "NODE_MAJOR=%%V"
    if defined NODE_MAJOR if !NODE_MAJOR! GEQ 22 (
      set "NODE_CMD=!SYSTEM_NODE!"
      set "NPM_CMD=!SYSTEM_NPM!"
    )
  )
)

if not defined NODE_CMD (
  echo   Node.js compativel nao encontrado.
  echo   Preparando uma copia portatil em .cache ^(sem instalar no Windows^)...
  echo.

  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-node.ps1"
  if errorlevel 1 goto :bootstrap_error

  set "NODE_CMD=%PORTABLE_NODE%"
  set "NPM_CMD=%PORTABLE_NPM%"
  set "PATH=%~dp0.cache\node-runtime;!PATH!"
)

set /p "=  Usando Node.js " <nul
"!NODE_CMD!" --version
echo.
echo   Instalando e conferindo as dependencias com npm ci...
echo   Isso pode demorar na primeira vez.
echo.

call "!NPM_CMD!" ci --no-audit --no-fund
if errorlevel 1 goto :npm_error

:config_menu
cls
echo.
echo   Sala de Tela - configuracao
echo   ===========================
echo.

if exist "%~dp0.env" (
  "!NODE_CMD!" "%~dp0scripts\config-status.mjs"
  echo.
  echo   1. Usar a configuracao atual
  echo   2. Reconfigurar
  echo   3. Sair
  echo.
  choice /c 123 /n /m "  Escolha [1-3]: "
  if errorlevel 3 goto :fim
  if errorlevel 2 goto :configurar
  goto :start_menu
) else (
  echo   Nenhum arquivo .env foi encontrado.
  echo   Voce pode configurar agora ou continuar sem preencher nada.
  echo.
  echo   1. Configurar agora
  echo   2. Continuar sem configuracao
  echo   3. Sair
  echo.
  choice /c 123 /n /m "  Escolha [1-3]: "
  if errorlevel 3 goto :fim
  if errorlevel 2 goto :start_menu
  goto :configurar
)

:configurar
cls
echo.
echo   Abrindo o assistente de configuracao...
echo.
call "!NPM_CMD!" run configurar
if errorlevel 1 goto :config_error
goto :start_menu

:start_menu
cls
echo.
echo   Sala de Tela - iniciar
echo   ======================
echo.
if exist "%~dp0.env" (
  "!NODE_CMD!" "%~dp0scripts\config-status.mjs"
) else (
  echo   Configuracao: nenhuma ^(.env ausente^)
)
echo.
echo   1. Iniciar normalmente
echo      Monta o site e sobe o servidor sem abrir tunel.
echo.
echo   2. Iniciar com start:fast
echo      Confirma a configuracao, abre o tunel e sobe tudo junto.
echo.
echo   3. Voltar para configuracao
echo   4. Sair
echo.
choice /c 1234 /n /m "  Escolha [1-4]: "
if errorlevel 4 goto :fim
if errorlevel 3 goto :config_menu
if errorlevel 2 goto :start_fast

:start_normal
cls
call "!NPM_CMD!" start
set "APP_EXIT=!ERRORLEVEL!"
goto :app_end

:start_fast
cls
call "!NPM_CMD!" run start:fast
set "APP_EXIT=!ERRORLEVEL!"
goto :app_end

:app_end
echo.
if not "!APP_EXIT!"=="0" (
  echo   O programa terminou com erro ^(codigo !APP_EXIT!^).
  pause
)
exit /b !APP_EXIT!

:bootstrap_error
echo.
echo   Nao foi possivel preparar o Node.js portatil.
echo   Confira sua internet e tente novamente.
echo.
pause
exit /b 1

:npm_error
echo.
echo   O npm ci falhou. Nenhuma versao foi iniciada com dependencias pela metade.
echo   Confira a internet, antivirus e espaco em disco, depois tente novamente.
echo.
pause
exit /b 1

:config_error
echo.
echo   A configuracao foi cancelada ou terminou com erro.
echo.
pause
goto :config_menu

:fim
echo.
echo   Ate a proxima.
exit /b 0

@echo off
rem Kalshi bot trainer: double-click to open the trainer window (progress bars, time left, what it is doing,
rem new versions offered). Choose how it trains there and press Start. TrainConsole.cmd is the console-only way.
setlocal
cd /d "%~dp0app"
title Kalshi bot trainer
echo.
echo  Kalshi bot trainer
echo  ------------------
echo  The trainer window opens in a moment (Microsoft Edge app window). Keep this console open while it
echo  trains: closing it stops the trainer (finished steps are kept; the next run continues).
echo  Data and models stay in "%~dp0trainer-data" between runs.
echo.
"%~dp0node\node.exe" "%~dp0app\dist\laptopTrain.cjs" --ui --data "%~dp0trainer-data" %*
rem 3 = a new version is being installed: the updater starts the trainer again by itself.
if "%ERRORLEVEL%"=="3" exit
echo.
pause

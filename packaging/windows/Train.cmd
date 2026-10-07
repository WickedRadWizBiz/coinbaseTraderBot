@echo off
rem Kalshi bot trainer: double-click to train every model on your own computer.
rem The first run asks for your server (optional) and downloads years of history; later runs only add what is new.
setlocal
cd /d "%~dp0app"
echo.
echo  Kalshi bot trainer
echo  ------------------
echo  Trains the TA network, setups, SNNs, volatility, Kalshi and perps models with the bot's own pipeline,
echo  keeps a new model only when it beats the one in use, and can send the winners to your server.
echo  Data and models stay in "%~dp0trainer-data" between runs. Close this window or press Ctrl+C to stop
echo  (finished steps are kept; the next run continues).
echo.
set "HOURS="
set /p HOURS=How many hours should it train? [12]: 
if "%HOURS%"=="" set HOURS=12
"%~dp0node\node.exe" "%~dp0app\dist\laptopTrain.cjs" --hours %HOURS% --data "%~dp0trainer-data" %*
echo.
pause

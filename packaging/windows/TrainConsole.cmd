@echo off
rem Kalshi bot trainer, console only (no window): asks for the hours here and prints everything in this console.
rem Train.cmd opens the trainer window instead.
rem The first run asks for your server (optional) and downloads years of history; later runs only add what is new.
setlocal
cd /d "%~dp0app"
echo.
echo  Kalshi bot trainer
echo  ------------------
echo  Trains the TA network, setups, SNNs, volatility, Kalshi and perps models with the bot's own pipeline,
echo  in rounds on history no network has trained on yet, keeps a new model only when it beats the one in
echo  use, and sends each improvement to your server. With 0 hours it keeps going until the bot stops
echo  improving or reaches the target (see trainer-data\GUIDE.txt; progress in trainer-data\STATUS.txt).
echo  Data and models stay in "%~dp0trainer-data" between runs. Close this window or press Ctrl+C to stop
echo  (finished steps are kept; the next run continues).
echo.
set "HOURS="
set /p HOURS=How many hours should it train? 0 = until it stops by itself [0]: 
if "%HOURS%"=="" set HOURS=0
"%~dp0node\node.exe" "%~dp0app\dist\laptopTrain.cjs" --hours %HOURS% --data "%~dp0trainer-data" %*
echo.
pause

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
echo  use, and sends the models to your server at the end. A session is 60 minutes unless you give another
echo  length (downloading new history comes first, outside the clock; see trainer-data\GUIDE.txt; progress
echo  in trainer-data\STATUS.txt).
echo  Data and models stay in "%~dp0trainer-data" between runs. Close this window or press Ctrl+C to stop
echo  (finished steps are kept; the next run continues).
echo.
set "MINUTES="
set /p MINUTES=How many minutes should this session train? [60]: 
if "%MINUTES%"=="" set MINUTES=60
"%~dp0node\node.exe" "%~dp0app\dist\laptopTrain.cjs" --minutes %MINUTES% --data "%~dp0trainer-data" %*
echo.
pause

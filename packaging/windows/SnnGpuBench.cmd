@echo off
rem SNN GPU prototype check: records a few hours of the crypto network's column steps from your replay, runs them
rem on the GPU for several population sizes, checks every member bit for bit against the TypeScript network and
rem times it. Takes a few minutes; the report is trainer-data\snn-gpu-bench.json. Close the trainer first.
setlocal
cd /d "%~dp0app"
"%~dp0node\node.exe" "%~dp0app\dist\laptopTrain.cjs" --snn-gpu-bench --data "%~dp0trainer-data" %*
echo.
pause

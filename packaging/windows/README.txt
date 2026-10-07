Kalshi bot trainer (Windows)
============================

1. Unzip this folder anywhere (it needs ~30 GB free for history and the bot's recordings).
2. Double-click Train.cmd and type how many hours to train (12 is a good first run; 48+ for a long one).
3. First run only: it asks for your server. To copy the bot's recorded market data from it and send the
   trained models back, give:
     - the Lightsail instance's public IP
     - the SSH user (ubuntu)
     - the instance's SSH key file: Lightsail console > Account > SSH keys > Download (a .pem file)
   Leave the address empty to train on downloaded history only (models then stay in trainer-data\models).
   Change these later with:  Train.cmd --setup

What it does: downloads years of crypto history (Binance, Coinbase) and a year of Kalshi's settled
contracts, copies the bot's own recordings, then runs the bot's training pipeline in rounds until the
time is up. Every model is promoted only if it beats the one the bot uses now. At the end the winners
are uploaded and the running bot loads them within a minute (no restart).

It uses the CPU (all models are small networks written in TypeScript); the graphics card is not used.
Your bot's passwords and API keys are never copied to this computer.

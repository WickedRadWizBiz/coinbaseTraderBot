Kalshi bot trainer (Windows)
============================

1. Unzip this folder anywhere (it needs ~40 GB free for history, its replay and the bot's recordings).
2. Double-click Train.cmd and press Enter (0 hours = keep training until the bot stops improving or
   reaches the target), or type a number of hours to stop sooner.
3. First run only: it asks for your server. To copy the bot's recorded market data from it and send the
   trained models back, give:
     - the Lightsail instance's public IP
     - the SSH user (ubuntu)
     - the instance's SSH key file: Lightsail console > Account > SSH keys > Download (a .pem file)
   Leave the address empty to train on downloaded history only (models then stay in trainer-data\models).
   Change these later with:  Train.cmd --setup

What it does: downloads years of crypto history (Binance spot, perpetuals, funding and open interest;
Coinbase) and a year of Kalshi's settled contracts, copies the bot's own recordings, then runs the bot's
training pipeline in rounds. Each round runs the networks' tournaments on weeks of history they have
never trained on, and a challenger must beat the model in use on held-out weeks before it replaces it.
After every round that improves a model, the models are uploaded and the running bot loads them within a
minute (no restart). It stops by itself when the whole bot reaches the target on held-out days, when 3
rounds in a row improve nothing, or when no fresh history is left.

Read trainer-data\GUIDE.txt (written on the first run): how many rounds to run before live trading,
what good scores look like, and why the default target ($100 a day on $200) is out of reach.
trainer-data\STATUS.txt shows the scores after every round. Change the target in trainer-data\trainer.env.

It uses the CPU (all models are small networks written in TypeScript); the graphics card is not used.
Your bot's passwords and API keys are never copied to this computer.

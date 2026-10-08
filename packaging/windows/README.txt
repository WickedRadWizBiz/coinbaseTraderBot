Kalshi bot trainer (Windows)
============================

1. Unzip this folder anywhere (it needs ~40 GB free for history, its replay and the bot's recordings).
2. Double-click Train.cmd. The trainer window opens (a Microsoft Edge app window, in the bot dashboard's
   look). In it:
     - choose how this run trains: "Continue where it left off" (the normal choice: only new data is
       downloaded, the tournaments carry on) or "Sweep everything again" (the first round runs every step
       now, even the weekly ones; your models and history are kept);
     - the hours to train (0 = keep training until the bot stops improving or reaches the target);
     - optionally your server, to copy the bot's recorded market data from it and send the trained models
       back: the Lightsail instance's public IP, the SSH user (ubuntu) and the instance's SSH key file
       (Lightsail console > Account > SSH keys > Download, a .pem file). Leave it empty to train on
       downloaded history only (models then stay in trainer-data\models).
   Press Start. Two progress bars show the downloads and the training with the time left (from how long the
   last rounds took and how fast the current step is going), a third the step in progress, and below them
   a short explanation of what the trainer is doing right now. Keep the console window open while it
   trains; closing it stops the trainer (finished steps are kept, the next run continues).
3. New versions: the window checks for a newer trainer when it starts and every 6 hours, and asks before
   installing one. If you say yes it stops training (finished steps are kept), downloads the new version,
   installs it over this folder (trainer-data is never touched) and opens again by itself.
   TrainConsole.cmd is the old console-only way (asks for the hours in the console; --setup for the server).

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

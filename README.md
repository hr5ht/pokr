# Pokr

Private Texas Hold'em for friends. Open the app, pick a name, and share a 4-digit code. There are no accounts or real money.

Download the Android app from [Releases](../../releases/latest).

## Features

- Guest profiles with no sign-up
- Private tables for up to 12 players, joined with a 4-digit code
- Host controls for blinds, starting stack, turn timer, pause, kick and changing the code
- Side pots, all-ins, rebuys and automatic folds when a turn timer runs out
- Hand rankings available during a game

## How it works

The server decides everything, and each phone only receives the cards its player is allowed to see.

Profiles and team codes use HTTPS. The table itself runs over a WebSocket, so a move reaches the other phones as soon as the server has it.

Vercel can run several instances and closes each socket after five minutes, so no game state lives in memory. Every table is a row in Postgres, a row lock stops two instances from overwriting each other, and `NOTIFY` tells every instance when a table changes. Each instance then sends the new table to the phones connected to it. The app swaps to a fresh socket before the five minutes are up and reconnects if replies stop arriving.

A table is deleted as soon as everyone has left, or after 4 hours with no connected phones or moves. Its code is then free to use again.

| Part | Stack |
| --- | --- |
| `app/` | Expo SDK 58, React Native, TypeScript |
| `server/` | FastAPI, psycopg, Postgres |
| Hosting | Vercel (Singapore) and Neon |

The poker rules are in `server/engine.py`, and the API is in `server/main.py`.

## Run locally

You need Node, Python 3.9 or newer, and a Postgres database.

Start the server:

```sh
cd server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt uvicorn
DATABASE_URL=postgresql://... .venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
```

Start the app, then open it in Expo Go:

```sh
cd app
npm install
npx expo start --lan
```

The app uses port 8000 on your dev machine by default. To point it at another server, create `app/.env`:

```sh
EXPO_PUBLIC_API_URL=https://your-server.example.com
```

## Deploy the server

Connect the repo to a Vercel project, set its Root Directory to `server`, and add `DATABASE_URL` as an environment variable. Every push to `main` then deploys automatically. Sockets need Fluid compute, which new projects have by default.

The region is set in `server/vercel.json`. The tables are created automatically on first use.

## Build the Android APK

You need Java 17 and the Android SDK. `app/.env` must exist first, because the API URL is built into the app.

```sh
cd app
npx expo prebuild --platform android --no-install
cd android
ANDROID_HOME=/path/to/android/sdk ./gradlew assembleRelease
```

The APK is written to `app/android/app/build/outputs/apk/release/app-release.apk`.

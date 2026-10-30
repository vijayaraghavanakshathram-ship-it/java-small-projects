# Jarvis — AI Chat Demo

A responsive chatbot interface with optional account sign-up/sign-in, voice control, and AI-generated answers. Say “Hey Jarvis” after enabling voice to start a spoken conversation.

## Run it

### Open in Chrome

- Run the FastAPI server using the steps below, then open `http://127.0.0.1:8000` in Chrome.
- Opening `index.html` directly or using a static file server won't provide AI answers because the API key must stay on the backend.

The page is branded as **Jarvis** and asks search engines not to index it. The `noindex` setting is not a security feature and does not prevent people from opening a publicly hosted page.

### Deploy on Render

1. Push this project to a GitHub repository.
2. In Render, choose **New → Blueprint** and select that repository. Render reads `render.yaml` to build and start the FastAPI app.
3. In the new service's **Environment** settings, set `JARVIS_AI_API_KEY` to a key from your OpenAI-compatible AI provider. Keep it private; do not put it in `app.js` or other browser files.
4. If your provider is not OpenAI, set `JARVIS_AI_BASE_URL` to its API base URL and `JARVIS_AI_MODEL` to a model available to your account. The defaults target OpenAI.
5. Open the HTTPS URL Render gives the service. When asked, allow microphone access and enable voice assistance.

This deployment uses a public backend endpoint with a limit of 30 chat requests per minute per running service instance. Provider usage may incur charges. The limit is in-memory and resets on restart; configure provider-side spending limits too. Voice recognition availability depends on the browser, and the browser/device must provide an English speech-recognition service. Jarvis chooses an English voice whose name appears male when available, but browsers do not expose reliable voice-gender metadata, so a male voice cannot be guaranteed on every device.

### Run the server locally

1. Install Python 3.10 or newer.
2. From this folder, install the dependencies: `python -m pip install -r requirements.txt`
3. Set `JARVIS_AI_API_KEY` in your environment, then start the server: `python -m uvicorn main:app --host 127.0.0.1 --port 8000`
4. Open `http://127.0.0.1:8000` in Chrome. Enable voice assistance and allow microphone access when prompted.

Set `JARVIS_AI_BASE_URL` and `JARVIS_AI_MODEL` to use another OpenAI-compatible provider. The SQLite database is created as `jarvis.sqlite3` in this folder by default. Set `JARVIS_DATABASE` to use a different database path. The app now needs its FastAPI backend for AI answers; do not publish just the static files if you expect voice questions to receive live answers. Render sets `JARVIS_COOKIE_SECURE=true`; use that setting for other HTTPS deployments too.

## Chat behavior

Jarvis sends questions to the configured AI provider and displays answers in chat; when voice assistance is on, it also reads answers aloud. It listens for “Hey Jarvis” only after the user enables voice and grants microphone permission.

## Controls

- Press **Enter** to send a message; use **Shift + Enter** for a new line.
- Select a suggestion card to try an example prompt.
- Select **New chat** or press **Ctrl/Cmd + K** to reset the conversation.
- Select **About demo** for a reminder that questions are sent to the configured AI provider.

## Public deployment notes

The account service remains optional and uses SQLite; on Render, local files may be lost when the service restarts unless a persistent disk is configured. Do not rely on it for important account data. The voice feature uses browser speech recognition, which may process audio through a browser-selected speech service. Spoken or typed questions are sent to the configured AI provider.

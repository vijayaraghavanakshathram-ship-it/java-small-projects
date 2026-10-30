import asyncio
import hashlib
import hmac
import logging
import os
import re
import secrets
import sqlite3
import time
from collections import deque
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import AsyncIterator, Iterator
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse


logger = logging.getLogger(__name__)
BASE_DIR = Path(__file__).resolve().parent
DATABASE_PATH = Path(os.environ.get("JARVIS_DATABASE", BASE_DIR / "jarvis.sqlite3"))
SESSION_COOKIE = "jarvis_session"
SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60
PASSWORD_ITERATIONS = 600_000
COOKIE_SECURE = os.environ.get("JARVIS_COOKIE_SECURE", "false").lower() == "true"
EMAIL_PATTERN = re.compile(r"[^@\s]{1,64}@[^@\s.]+(?:\.[^@\s.]+)+")
AI_API_KEY = os.environ.get("JARVIS_AI_API_KEY", "").strip()
AI_BASE_URL = os.environ.get(
    "JARVIS_AI_BASE_URL", "https://api.openai.com/v1"
).rstrip("/")
AI_MODEL = os.environ.get("JARVIS_AI_MODEL", "gpt-4o-mini").strip()
CHAT_REQUEST_LIMIT = 30
CHAT_REQUEST_WINDOW_SECONDS = 60
chat_request_times: deque[float] = deque()
chat_request_lock = asyncio.Lock()


@contextmanager
def database() -> Iterator[sqlite3.Connection]:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize_database() -> None:
    with database() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
            DELETE FROM sessions WHERE expires_at <= strftime('%s', 'now');
            """
        )


def hash_password(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS
    )


def validate_credentials(payload: object) -> tuple[str, str]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid request.")

    email = payload.get("email")
    password = payload.get("password")
    if not isinstance(email, str) or not isinstance(password, str):
        raise HTTPException(status_code=400, detail="Email and password are required.")

    email = email.strip().lower()
    if len(email) > 254 or not EMAIL_PATTERN.fullmatch(email):
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    if len(password) < 12:
        raise HTTPException(
            status_code=400, detail="Password must be at least 12 characters."
        )
    if len(password) > 128:
        raise HTTPException(
            status_code=400, detail="Password must be 128 characters or fewer."
        )
    return email, password


def validate_same_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if not origin:
        return
    parsed_origin = urlsplit(origin)
    request_origin = urlsplit(str(request.base_url))
    if (parsed_origin.scheme, parsed_origin.netloc) != (
        request_origin.scheme,
        request_origin.netloc,
    ):
        raise HTTPException(status_code=403, detail="Cross-origin request rejected.")


async def enforce_chat_rate_limit() -> None:
    now = time.monotonic()
    async with chat_request_lock:
        while (
            chat_request_times
            and now - chat_request_times[0] >= CHAT_REQUEST_WINDOW_SECONDS
        ):
            chat_request_times.popleft()
        if len(chat_request_times) >= CHAT_REQUEST_LIMIT:
            raise HTTPException(
                status_code=429,
                detail="Jarvis is receiving a lot of requests. Please try again shortly.",
            )
        chat_request_times.append(now)


async def get_ai_reply(message: str) -> str:
    if not AI_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="AI answers aren't configured yet. Set JARVIS_AI_API_KEY on the server.",
        )

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{AI_BASE_URL}/chat/completions",
                headers={"Authorization": f"Bearer {AI_API_KEY}"},
                json={
                    "model": AI_MODEL,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "You are Jarvis, a helpful assistant. Answer clearly "
                                "and conversationally, using concise responses suitable "
                                "for being read aloud."
                            ),
                        },
                        {"role": "user", "content": message},
                    ],
                    "max_tokens": 500,
                },
            )
            response.raise_for_status()
            payload = response.json()
    except httpx.HTTPStatusError as error:
        logger.error("AI provider returned HTTP %s", error.response.status_code)
        raise HTTPException(
            status_code=502,
            detail="The AI provider couldn't answer. Check the server's provider settings.",
        ) from error
    except httpx.RequestError as error:
        logger.exception("Could not reach the configured AI provider")
        raise HTTPException(
            status_code=502, detail="Jarvis couldn't reach the AI provider."
        ) from error
    except ValueError as error:
        logger.exception("AI provider returned invalid JSON")
        raise HTTPException(
            status_code=502, detail="The AI provider returned an invalid response."
        ) from error

    try:
        reply = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        logger.error("AI provider response did not contain a chat completion")
        raise HTTPException(
            status_code=502, detail="The AI provider returned an unexpected response."
        ) from error
    if not isinstance(reply, str) or not reply.strip():
        raise HTTPException(
            status_code=502, detail="The AI provider returned an empty answer."
        )
    return reply.strip()


def issue_session(response: Response, user_id: int) -> None:
    raw_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode("ascii")).hexdigest()
    expires_at = int(time.time()) + SESSION_DURATION_SECONDS
    with database() as connection:
        connection.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (token_hash, user_id, expires_at),
        )
    response.set_cookie(
        SESSION_COOKIE,
        raw_token,
        max_age=SESSION_DURATION_SECONDS,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="strict",
        path="/",
    )


def current_user(request: Request) -> sqlite3.Row | None:
    raw_token = request.cookies.get(SESSION_COOKIE)
    if not raw_token:
        return None

    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    with database() as connection:
        row = connection.execute(
            """
            SELECT users.id, users.email, sessions.expires_at
            FROM sessions JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ?
            """,
            (token_hash,),
        ).fetchone()
        if row is not None and row["expires_at"] <= int(time.time()):
            connection.execute(
                "DELETE FROM sessions WHERE token_hash = ?", (token_hash,)
            )
            return None
        return row


def get_demo_reply(message: str) -> str:
    text = message.lower()
    if re.search(r"\b(hi|hello|hey|good morning|good afternoon|good evening)\b", text):
        return (
            "Hi there! I'm Jarvis, a chatbot demo. I can share a fun fact, suggest "
            "a writing prompt, help sketch out a simple plan, or chat about space. "
            "What sounds good?"
        )
    if re.search(r"\b(write|writing|creative|story|prompt|poem)\b", text):
        return (
            "Here's a writing prompt: A small bookstore receives a book that "
            "describes tomorrow in perfect detail—but the final page is blank. "
            "What happens next?"
        )
    if re.search(r"\b(plan|schedule|day|organize|organise|today|week)\b", text):
        return (
            "Try this simple plan:\n\n1. Pick your top priority and give it a focused "
            "45-minute block.\n2. Take a short break, then handle one quick task.\n"
            "3. Leave some room for lunch and a walk.\n4. Wrap up by noting one "
            "thing to start with tomorrow.\n\nTell me what you need to fit in and I "
            "can help shape the plan."
        )
    if re.search(r"\b(space|planet|star|moon|universe|astronomy)\b", text):
        return (
            "Here's a space fact: a day on Venus is longer than its year. Venus "
            "takes about 243 Earth days to rotate once, but only about 225 Earth "
            "days to orbit the Sun."
        )
    if re.search(r"\b(fun fact|surprise|interesting|fact)\b", text):
        return (
            "Fun fact: octopuses have three hearts. Two pump blood to the gills, "
            "while the third sends it to the rest of the body."
        )
    if re.search(r"\b(help|what can you do|capabilities)\b", text):
        return (
            "I can respond to a few demo topics: greetings, creative writing "
            "prompts, simple day planning, space facts, and fun facts. Try one of "
            "those—or ask me something else to see the demo fallback."
        )
    if re.search(r"\b(thank|thanks|thx)\b", text):
        return (
            "You're welcome! This is a scripted demo, so my replies are limited—but "
            "you can keep exploring the example prompts."
        )
    if re.search(r"\b(bye|goodbye|see you)\b", text):
        return "See you next time! Start a new chat whenever you'd like to explore another prompt."
    return (
        "That's an interesting question. I'm running in demo mode, so I don't have "
        "a live AI model connected yet. Try asking for a writing prompt, a simple "
        "day plan, a space fact, or a fun fact—or connect an AI API to make Jarvis "
        "answer freely."
    )


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    initialize_database()
    yield


app = FastAPI(
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.middleware("http")
async def set_api_cache_headers(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/")
def home() -> FileResponse:
    return FileResponse(BASE_DIR / "index.html")


@app.get("/styles.css")
def stylesheet() -> FileResponse:
    return FileResponse(BASE_DIR / "styles.css", media_type="text/css")


@app.get("/app.js")
def javascript() -> FileResponse:
    return FileResponse(BASE_DIR / "app.js", media_type="text/javascript")


@app.post("/api/auth/signup")
async def signup(request: Request, response: Response) -> dict[str, object]:
    validate_same_origin(request)
    try:
        payload = await request.json()
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Invalid JSON body.") from error
    email, password = validate_credentials(payload)
    salt = secrets.token_bytes(16)
    password_hash = hash_password(password, salt)

    try:
        with database() as connection:
            cursor = connection.execute(
                """
                INSERT INTO users (email, salt, password_hash, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (email, salt.hex(), password_hash.hex(), int(time.time())),
            )
            user_id = cursor.lastrowid
    except sqlite3.IntegrityError as error:
        raise HTTPException(
            status_code=409, detail="An account with that email already exists."
        ) from error

    issue_session(response, user_id)
    return {"authenticated": True, "email": email}


@app.post("/api/auth/login")
async def login(request: Request, response: Response) -> dict[str, object]:
    validate_same_origin(request)
    try:
        payload = await request.json()
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Invalid JSON body.") from error
    email, password = validate_credentials(payload)

    with database() as connection:
        user = connection.execute(
            "SELECT id, email, salt, password_hash FROM users WHERE email = ?",
            (email,),
        ).fetchone()

    salt = bytes.fromhex(user["salt"]) if user else bytes(16)
    stored_hash = bytes.fromhex(user["password_hash"]) if user else bytes(32)
    password_matches = hmac.compare_digest(hash_password(password, salt), stored_hash)
    if user is None or not password_matches:
        raise HTTPException(status_code=401, detail="Email or password is incorrect.")

    issue_session(response, user["id"])
    return {"authenticated": True, "email": user["email"]}


@app.get("/api/me")
def me(request: Request) -> dict[str, object]:
    user = current_user(request)
    if user is None:
        return {"authenticated": False}
    return {"authenticated": True, "email": user["email"]}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response) -> dict[str, bool]:
    validate_same_origin(request)
    raw_token = request.cookies.get(SESSION_COOKIE)
    if raw_token:
        token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        with database() as connection:
            connection.execute(
                "DELETE FROM sessions WHERE token_hash = ?", (token_hash,)
            )
    response.delete_cookie(
        SESSION_COOKIE,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="strict",
        path="/",
    )
    return {"logged_out": True}


@app.post("/api/chat")
async def chat(request: Request) -> dict[str, str]:
    validate_same_origin(request)
    try:
        payload = await request.json()
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Invalid JSON body.") from error
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid request.")
    message = payload.get("message")
    if not isinstance(message, str) or not message.strip():
        raise HTTPException(status_code=400, detail="Enter a message.")
    if len(message) > 2000:
        raise HTTPException(status_code=400, detail="Message must be 2000 characters or fewer.")
    await enforce_chat_rate_limit()
    return {"reply": await get_ai_reply(message.strip())}

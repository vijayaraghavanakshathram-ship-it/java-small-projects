const form = document.querySelector("#chat-form");
const input = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const messages = document.querySelector("#messages");
const welcome = document.querySelector("#welcome");
const newChatButton = document.querySelector("#new-chat");
const chatTitle = document.querySelector("#chat-title");
const toast = document.querySelector("#toast");
const authScreen = document.querySelector("#auth-screen");
const appShell = document.querySelector("#app-shell");
const authForm = document.querySelector("#auth-form");
const authEmail = document.querySelector("#auth-email");
const authPassword = document.querySelector("#auth-password");
const authError = document.querySelector("#auth-error");
const authTitle = document.querySelector("#auth-title");
const authDescription = document.querySelector("#auth-description");
const authSubmit = document.querySelector("#auth-submit");
const authSwitchCopy = document.querySelector("#auth-switch-copy");
const authSwitch = document.querySelector("#auth-switch");
const profileEmail = document.querySelector("#profile-email");
const logoutButton = document.querySelector("#logout");
const accountButton = document.querySelector("#account-button");
const loginPrompt = document.querySelector("#login-prompt");
const voiceToggle = document.querySelector("#voice-toggle");
const voiceOptIn = document.querySelector("#voice-optin");
const voiceEnableButton = document.querySelector("#voice-enable");
const voiceSkipButton = document.querySelector("#voice-skip");

let toastTimeout;
let authMode = "login";
let chatCount = 0;
let loginPromptShown = false;
let authenticated = false;
let accountApiAvailable = false;
let voiceEnabled = false;
let voiceStarting = false;
let voiceSpeaking = false;
let voiceBusy = false;
let waitingForQuestion = false;
let voiceRestartTimer;
let recognition;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function formatTime(date = new Date()) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function updateVoiceControls(status) {
  voiceToggle.textContent = voiceEnabled ? "Voice on · Stop" : "Enable voice";
  voiceToggle.setAttribute("aria-pressed", String(voiceEnabled));
  voiceToggle.setAttribute(
    "aria-label",
    voiceEnabled ? "Turn off voice assistance" : "Enable voice assistance",
  );
  voiceToggle.title = status;
}

function stopVoiceAssistant() {
  voiceEnabled = false;
  waitingForQuestion = false;
  window.clearTimeout(voiceRestartTimer);
  if (recognition) {
    try {
      recognition.stop();
    } catch (error) {
      if (error.name !== "InvalidStateError") {
        showToast("Couldn't stop voice recognition cleanly.");
      }
    }
  }
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  voiceSpeaking = false;
  updateVoiceControls("Voice assistance is off");
}

function startListening() {
  if (!voiceEnabled || voiceSpeaking || voiceBusy || voiceStarting || !recognition) return;
  try {
    voiceStarting = true;
    recognition.start();
  } catch (error) {
    voiceStarting = false;
    if (error.name !== "InvalidStateError") {
      showToast("Couldn't start voice recognition. Check microphone permission and try again.");
    }
  }
}

function speakReply(text) {
  if (!voiceEnabled || !("speechSynthesis" in window)) return;
  if (recognition) {
    try {
      recognition.stop();
    } catch (error) {
      if (error.name !== "InvalidStateError") {
        showToast("Couldn't pause voice recognition while Jarvis speaks.");
      }
    }
  }
  voiceSpeaking = true;
  updateVoiceControls("Jarvis is speaking");

  const utterance = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  const englishVoices = voices.filter((voice) => /^en([_-]|$)/i.test(voice.lang));
  const maleNamedVoice = englishVoices.find((voice) =>
    /\b(male|daniel|david|fred|george|guy|james|john|mark|matthew|michael|oliver|ryan|thomas)\b/i.test(voice.name),
  );
  utterance.voice = maleNamedVoice || englishVoices.find((voice) => voice.default) || englishVoices[0] || null;
  utterance.lang = utterance.voice?.lang || "en-US";
  utterance.pitch = 0.9;
  utterance.rate = 1;
  const resumeListening = () => {
    voiceSpeaking = false;
    if (voiceEnabled) {
      updateVoiceControls(waitingForQuestion ? "Listening for your question" : "Say “Hey Jarvis”");
      window.setTimeout(startListening, 250);
    }
  };
  utterance.onend = resumeListening;
  utterance.onerror = resumeListening;
  window.speechSynthesis.speak(utterance);
}

function enableVoiceAssistant() {
  voiceOptIn.hidden = true;
  if (!SpeechRecognition) {
    showToast("Voice recognition isn't supported by this browser. Try a current version of Chrome or Edge.");
    return;
  }
  if (!("speechSynthesis" in window)) {
    showToast("Spoken replies aren't supported by this browser.");
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = "en-US";
  recognition.onstart = () => {
    voiceStarting = false;
    updateVoiceControls(waitingForQuestion ? "Listening for your question" : "Say “Hey Jarvis”");
  };
  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      if (!event.results[index].isFinal) continue;
      const transcript = event.results[index][0].transcript.trim();
      if (!transcript) continue;

      if (waitingForQuestion) {
        waitingForQuestion = false;
        const query = transcript.replace(/^\s*hey[\s,]+jarvis[\s,.:;!?-]*/i, "").trim();
        if (query) {
          sendMessage(query);
        } else {
          speakReply("I didn't catch that. What would you like to ask?");
        }
        return;
      }

      const wakeWord = /\bhey[\s,]+jarvis\b/i.exec(transcript);
      if (!wakeWord) continue;
      const query = transcript
        .slice(wakeWord.index + wakeWord[0].length)
        .trim()
        .replace(/^[,.:;!?-]+\s*/, "");
      if (query) {
        sendMessage(query);
      } else {
        waitingForQuestion = true;
        speakReply("Hello sir. How can I help?");
      }
      return;
    }
  };
  recognition.onerror = (event) => {
    voiceStarting = false;
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      showToast("Microphone access was denied. Allow microphone access to use voice assistance.");
      stopVoiceAssistant();
    } else if (event.error !== "no-speech" && event.error !== "aborted") {
      showToast("Voice recognition stopped. Check your connection and microphone settings.");
    }
  };
  recognition.onend = () => {
    voiceStarting = false;
    if (voiceEnabled && !voiceSpeaking && !voiceBusy) {
      window.clearTimeout(voiceRestartTimer);
      voiceRestartTimer = window.setTimeout(startListening, 300);
    }
  };

  voiceEnabled = true;
  updateVoiceControls("Say “Hey Jarvis”");
  startListening();
}

async function apiRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch {
    const error = new Error("Can't reach Jarvis.");
    error.code = "NETWORK_UNAVAILABLE";
    throw error;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.detail || "Something went wrong. Please try again.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function showAuthError(message) {
  authError.textContent = message;
  authError.hidden = !message;
}

function setAuthenticated(user) {
  authenticated = true;
  profileEmail.textContent = user.email;
  logoutButton.hidden = false;
  accountButton.hidden = true;
  authScreen.hidden = true;
  input.focus();
}

function setUnauthenticated() {
  authenticated = false;
  profileEmail.textContent = "Guest mode";
  logoutButton.hidden = true;
  accountButton.hidden = !accountApiAvailable;
}

function openAuthScreen() {
  loginPrompt.hidden = true;
  authScreen.hidden = false;
  authPassword.value = "";
  authEmail.value = "";
  authMode = "login";
  updateAuthMode();
  authEmail.focus();
}

function closeLoginPrompt() {
  loginPrompt.hidden = true;
  loginPromptShown = true;
}

function maybeShowLoginPrompt() {
  if (accountApiAvailable && chatCount >= 3 && !loginPromptShown && !authenticated) {
    loginPrompt.hidden = false;
    loginPromptShown = true;
    document.querySelector("#prompt-close").focus();
  }
}

function updateAuthMode() {
  const creatingAccount = authMode === "signup";
  authTitle.textContent = creatingAccount ? "Create your account." : "Welcome back.";
  authDescription.textContent = creatingAccount
    ? "Create an account to start using your Jarvis workspace."
    : "Sign in to continue to your Jarvis workspace.";
  authSubmit.textContent = creatingAccount ? "Create account" : "Sign in";
  authSwitchCopy.textContent = creatingAccount ? "Already have an account?" : "New to Jarvis?";
  authSwitch.textContent = creatingAccount ? "Sign in" : "Create an account";
  authPassword.autocomplete = creatingAccount ? "new-password" : "current-password";
  showAuthError("");
}

function addMessage(role, text, { typing = false } = {}) {
  const article = document.createElement("article");
  article.className = `message ${role}${typing ? " typing" : ""}`;

  if (role === "assistant") {
    const avatar = document.createElement("div");
    avatar.className = "assistant-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = "✳";
    article.append(avatar);
  }

  const body = document.createElement("div");
  body.className = "message-body";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const name = document.createElement("strong");
  name.textContent = role === "user" ? "You" : "Jarvis";
  const time = document.createElement("span");
  time.textContent = formatTime();
  meta.append(name, time);

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (typing) {
    bubble.setAttribute("aria-label", "Jarvis is typing");
    for (let index = 0; index < 3; index += 1) {
      const dot = document.createElement("span");
      dot.className = "typing-dot";
      dot.setAttribute("aria-hidden", "true");
      bubble.append(dot);
    }
  } else {
    bubble.textContent = text;
  }

  body.append(meta, bubble);
  article.append(body);
  messages.append(article);
  article.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return article;
}

function updateInputState() {
  sendButton.disabled = input.value.trim().length === 0;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
}

async function sendMessage(text) {
  const message = text.trim();
  if (!message) return;
  voiceBusy = voiceEnabled;
  if (voiceBusy && recognition) {
    try {
      recognition.stop();
    } catch (error) {
      if (error.name !== "InvalidStateError") {
        showToast("Couldn't pause voice recognition while Jarvis answers.");
      }
    }
  }

  welcome.hidden = true;
  if (messages.childElementCount === 0) {
    chatTitle.textContent = message.length > 25 ? `${message.slice(0, 25)}…` : message;
  }
  addMessage("user", message);
  chatCount += 1;
  input.value = "";
  updateInputState();

  const typing = addMessage("assistant", "", { typing: true });
  let spokenReply = "";
  try {
    const data = await apiRequest("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    if (typeof data.reply !== "string" || !data.reply.trim()) {
      throw new Error("Jarvis returned an invalid answer.");
    }
    typing.remove();
    addMessage("assistant", data.reply);
    spokenReply = data.reply;
  } catch (error) {
    typing.remove();
    addMessage("assistant", error.message);
    spokenReply = error.message;
  } finally {
    voiceBusy = false;
    if (voiceEnabled) speakReply(spokenReply);
  }
  maybeShowLoginPrompt();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(input.value);
  input.focus();
});

input.addEventListener("input", updateInputState);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => sendMessage(button.dataset.prompt || ""));
});

newChatButton.addEventListener("click", () => {
  messages.replaceChildren();
  welcome.hidden = false;
  chatTitle.textContent = "A fresh start";
  input.value = "";
  updateInputState();
  input.focus();
});

document.querySelector("#about-demo").addEventListener("click", () => {
  showToast("Typed and spoken questions are sent to the configured AI provider.");
});

accountButton.addEventListener("click", openAuthScreen);
voiceToggle.addEventListener("click", () => {
  if (voiceEnabled) {
    stopVoiceAssistant();
  } else {
    voiceOptIn.hidden = false;
    voiceEnableButton.focus();
  }
});
voiceEnableButton.addEventListener("click", enableVoiceAssistant);
voiceSkipButton.addEventListener("click", () => {
  voiceOptIn.hidden = true;
});
document.querySelector("#auth-back").addEventListener("click", () => {
  authScreen.hidden = true;
  showAuthError("");
  input.focus();
});
document.querySelector("#prompt-sign-in").addEventListener("click", openAuthScreen);
document.querySelector("#prompt-close").addEventListener("click", closeLoginPrompt);
document.querySelector("#prompt-continue").addEventListener("click", closeLoginPrompt);
loginPrompt.addEventListener("click", (event) => {
  if (event.target === loginPrompt) closeLoginPrompt();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !loginPrompt.hidden) closeLoginPrompt();
  if (event.key === "Escape" && !voiceOptIn.hidden) voiceOptIn.hidden = true;
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    newChatButton.click();
  }
});

authSwitch.addEventListener("click", () => {
  authMode = authMode === "login" ? "signup" : "login";
  updateAuthMode();
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showAuthError("");
  authSubmit.disabled = true;
  try {
    if (window.location.protocol === "file:") {
      throw new Error("Account sign-in needs the FastAPI server. See README.md for setup; guest chat works without it.");
    }
    const user = await apiRequest(`/api/auth/${authMode}`, {
      method: "POST",
      body: JSON.stringify({
        email: authEmail.value,
        password: authPassword.value,
      }),
    });
    authPassword.value = "";
    setAuthenticated(user);
    showToast("You're signed in to Jarvis.");
  } catch (error) {
    showAuthError(error.message);
  } finally {
    authSubmit.disabled = false;
  }
});

document.querySelector("#logout").addEventListener("click", async () => {
  try {
    await apiRequest("/api/auth/logout", { method: "POST" });
    setUnauthenticated();
    showToast("Signed out. You can keep chatting as a guest.");
  } catch (error) {
    showToast(error.message);
  }
});

async function restoreSession() {
  try {
    const user = await apiRequest("/api/me");
    if (typeof user.authenticated !== "boolean") {
      setUnauthenticated();
      return;
    }
    accountApiAvailable = true;
    if (user.authenticated) {
      setAuthenticated(user);
    } else {
      setUnauthenticated();
    }
  } catch (error) {
    accountApiAvailable = false;
    setUnauthenticated();
    if (error.status !== 404 && error.code !== "NETWORK_UNAVAILABLE") {
      showToast("Account sign-in isn't available. You can still chat as a guest.");
    }
  }
}

updateAuthMode();
updateVoiceControls("Voice assistance is off");
restoreSession();

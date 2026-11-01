const chat = document.getElementById("chat");
const appShell = document.querySelector(".app-shell");
const form = document.getElementById("chatForm");
const question = document.getElementById("question");
const groqApiKey = document.getElementById("groqApiKey");
const trace = document.getElementById("trace");
const sourceUsed = document.getElementById("sourceUsed");
const sidebar = document.getElementById("sidebar");
const tracePanel = document.getElementById("tracePanel");
const scrim = document.getElementById("scrim");
const modal = document.getElementById("uploadModal");
const answerModal = document.getElementById("answerModal");
const sendButton = document.getElementById("sendButton");
const uploadButton = document.getElementById("uploadBtn");
const openMenuButton = document.getElementById("openMenu");
const openTraceButton = document.getElementById("openTrace");
const uploadLimit = document.getElementById("uploadLimit");
const sidebarBreakpoint = window.matchMedia("(max-width: 760px)");
const activityBreakpoint = window.matchMedia("(max-width: 1120px)");
let activeModal = null;
let previousFocus = null;
let latestAnswer = null;

function formatFileSize(bytes) {
  const megabyte = 1024 * 1024;
  return bytes >= megabyte
    ? `${Math.round((bytes / megabyte) * 10) / 10} MB`
    : `${bytes} bytes`;
}

function setUploadStatus(message, state = "") {
  const status = document.getElementById("uploadStatus");
  status.textContent = message;
  status.className = `upload-status ${state}`;
  status.setAttribute("aria-live", state === "error" ? "assertive" : "polite");
}

function escapeHtml(value = "") {
  return String(value).replace(
    /[&<>'"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      })[character],
  );
}

function formatInline(text = "") {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function formatText(text = "") {
  const blocks = [];
  let listType = "";
  let listItems = [];

  function flushList() {
    if (!listItems.length) return;
    blocks.push(`<${listType}>${listItems.join("")}</${listType}>`);
    listItems = [];
    listType = "";
  }

  for (const line of String(text).replace(/\r\n/g, "\n").split("\n")) {
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);

    if (unordered || ordered) {
      const nextType = unordered ? "ul" : "ol";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push(`<li>${formatInline((unordered || ordered)[1])}</li>`);
      continue;
    }

    flushList();
    if (!line.trim()) continue;
    if (heading) {
      const level = line.match(/^#+/)[0].length;
      blocks.push(`<h${level}>${formatInline(heading[1])}</h${level}>`);
    } else if (/^\s*[-*_]{3,}\s*$/.test(line)) {
      blocks.push("<hr>");
    } else {
      blocks.push(`<p>${formatInline(line)}</p>`);
    }
  }
  flushList();
  return blocks.join("");
}

function safeCitationUrl(value) {
  try {
    const url = new URL(value, window.location.origin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function scrollDown() {
  chat.scrollTo({ top: chat.scrollHeight, behavior: "smooth" });
}

function addMessage(role, text, source = "", citations = []) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;
  wrapper.dataset.answer = text;
  wrapper.dataset.source = source;

  const citationsHtml = citations.length
    ? `<div class="citations"><strong>Sources</strong><br>${citations
        .map((citation) => {
          const title = escapeHtml(citation?.title || "Source");
          const url = safeCitationUrl(citation?.url || "");
          return url
            ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
            : title;
        })
        .join("<br>")}</div>`
    : "";
  const sourceHtml = source
    ? `<div class="answer-source">Source: ${escapeHtml(source)}</div>`
    : "";
  const actionsHtml =
    role === "assistant" && source
      ? '<div class="answer-actions"><button type="button" data-answer-action="view">Open answer screen</button></div>'
      : "";
  const avatar = role === "assistant" ? '<div class="avatar" aria-hidden="true">A</div>' : "";

  wrapper.innerHTML = `${avatar}<div class="bubble">${formatText(text)}${sourceHtml}${citationsHtml}${actionsHtml}</div>`;
  if (role === "assistant" && source) {
    wrapper.answerData = { question: "", answer: text, source, citations };
  }
  chat.appendChild(wrapper);
  scrollDown();
  return wrapper;
}

function showAnswerScreen(answer) {
  latestAnswer = answer;
  document.getElementById("answerQuestion").textContent = answer.question;
  document.getElementById("answerContent").innerHTML = formatText(answer.answer);
  document.getElementById("answerSource").textContent = `Source: ${answer.source}`;

  const citations = document.getElementById("answerCitations");
  citations.replaceChildren();
  if (answer.citations.length) {
    const heading = document.createElement("strong");
    heading.textContent = "Sources";
    citations.append(heading, document.createElement("br"));
    answer.citations.forEach((citation, index) => {
      if (index) citations.append(document.createElement("br"));
      const title = citation?.title || "Source";
      const url = safeCitationUrl(citation?.url || "");
      if (url) {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = title;
        citations.append(link);
      } else {
        citations.append(document.createTextNode(title));
      }
    });
    citations.classList.remove("hidden");
  } else {
    citations.classList.add("hidden");
  }

  document.getElementById("answerActionStatus").textContent = "";
  openModal(answerModal, document.getElementById("closeAnswer"));
}

function showTyping() {
  const wrapper = document.createElement("div");
  wrapper.className = "message assistant";
  wrapper.id = "typing";
  wrapper.innerHTML =
    '<div class="avatar" aria-hidden="true">A</div><div class="bubble"><div class="typing" role="status" aria-label="AssistIQ is preparing an answer"><span></span><span></span><span></span></div></div>';
  chat.appendChild(wrapper);
  scrollDown();
}

function hideTyping() {
  document.getElementById("typing")?.remove();
}

function renderTrace(items) {
  const safeItems = Array.isArray(items)
    ? items.filter((item) => typeof item === "string" && item.trim())
    : [];
  trace.innerHTML = safeItems.length
    ? safeItems.map((item) => `<div class="trace-item">${escapeHtml(item)}</div>`).join("")
    : '<div class="trace-item">No workflow activity was returned.</div>';
}

async function copyAnswer(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Continue to the document-copy fallback when clipboard permissions are unavailable.
  }

  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) {
    throw new Error("Clipboard access is unavailable.");
  }
}

function renderIntegrations(status) {
  const appStatus = document.getElementById("appStatus");
  const summary = document.getElementById("integrationSummary");
  const list = document.getElementById("integrationList");
  const checks = status?.checks;

  if (!checks || typeof checks !== "object") {
    throw new Error("The server returned an invalid setup status.");
  }
  if (
    Number.isSafeInteger(status.max_upload_size_bytes) &&
    status.max_upload_size_bytes > 0
  ) {
    uploadLimit.dataset.maxBytes = String(status.max_upload_size_bytes);
    uploadLimit.textContent = `Supported formats: PDF, TXT, Markdown, DOCX. Maximum size: ${formatFileSize(status.max_upload_size_bytes)}.`;
  }

  const entries = Object.values(checks);
  const requiredEntries = entries.filter((entry) => entry?.optional !== true);
  const configuredCount = requiredEntries.filter(
    (entry) => entry?.configured === true,
  ).length;
  const isReady =
    status.readiness === "ready" && configuredCount === requiredEntries.length;
  appStatus.textContent = isReady ? "Ready" : "Setup needed";
  appStatus.className = `setup-pill ${isReady ? "ready" : "needs-setup"}`;
  summary.textContent = isReady
    ? "Required services are configured. Credentials are stored server-side."
    : `${configuredCount} of ${requiredEntries.length} required services configured. Add missing keys on the server.`;
  list.innerHTML = entries
    .map((entry) => {
      const configured = entry?.configured === true;
      const state = configured
        ? "configured"
        : entry?.optional === true
          ? "not set (optional)"
          : "needs setup";
      return `<li class="integration-row"><span class="integration-dot ${configured ? "ready" : ""}"></span><span>${escapeHtml(entry?.label || "Service")}: ${state}</span></li>`;
    })
    .join("");
}

async function loadReadiness() {
  const appStatus = document.getElementById("appStatus");
  const summary = document.getElementById("integrationSummary");
  try {
    const response = await fetch("/api/status", { headers: { Accept: "application/json" } });
    const body = await response.text();
    const data = body ? JSON.parse(body) : {};
    if (!response.ok) {
      throw new Error(typeof data.detail === "string" ? data.detail : `HTTP ${response.status}`);
    }
    renderIntegrations(data);
  } catch {
    appStatus.textContent = "Unavailable";
    appStatus.className = "setup-pill error";
    summary.textContent = "Unable to verify server configuration. Check the service and try again.";
    document.getElementById("integrationList").innerHTML =
      '<li class="integration-row"><span class="integration-dot"></span><span>Setup status unavailable</span></li>';
  }
}

let requestPending = false;

async function askAgent(rawQuestion) {
  const value = rawQuestion.trim();
  if (!value || requestPending) return;
  if (value.length < 2) {
    question.setCustomValidity("Enter at least 2 characters for your question.");
    question.reportValidity();
    return;
  }
  question.setCustomValidity("");
  requestPending = true;
  const requestGroqApiKey = groqApiKey.value.trim();

  chat.querySelector(".welcome-block")?.remove();
  chat.querySelector(".welcome-message")?.remove();
  addMessage("user", value);
  question.value = "";
  resizeQuestion();
  renderTrace(["Starting the AssistIQ workflow…"]);
  sourceUsed.textContent = "Preparing answer";
  sendButton.disabled = true;
  question.disabled = true;
  document.querySelectorAll(".example").forEach((button) => {
    button.disabled = true;
  });
  showTyping();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(requestGroqApiKey ? { "X-Groq-API-Key": requestGroqApiKey } : {}),
      },
      body: JSON.stringify({ question: value }),
    });
    const body = await response.text();
    let data = {};
    if (body) {
      try {
        data = JSON.parse(body);
      } catch {
        throw new Error("The assistant returned an invalid response. Please try again.");
      }
    }
    if (!response.ok) {
      const message =
        typeof data?.detail === "string"
          ? data.detail
          : `The assistant service is temporarily unavailable (HTTP ${response.status}). Please try again shortly.`;
      throw new Error(message);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("The assistant returned an invalid response. Please try again.");
    }
    if (typeof data.answer !== "string" || !data.answer.trim()) {
      throw new Error("The assistant returned an empty answer. Please try again.");
    }

    hideTyping();
    const sourceLabels = {
      private_kb: "Your private knowledge base",
      web_search: "External web search",
      direct: "Assistant response",
      insufficient_evidence: "Not enough reliable evidence",
    };
    const source = sourceLabels[data.source_used] || data.source_used || "Source not specified";
    const citations = Array.isArray(data.citations) ? data.citations : [];
    const answerMessage = addMessage(
      "assistant",
      data.answer,
      source,
      citations,
    );
    answerMessage.answerData.question = value;
    showAnswerScreen({ question: value, answer: data.answer, source, citations });
    renderTrace(data.trace);
    sourceUsed.textContent = source;
  } catch (error) {
    hideTyping();
    const message =
      error instanceof TypeError
        ? "Couldn't reach AssistIQ. Check your connection and try again."
        : error instanceof Error
          ? error.message
          : "The request failed. Please try again.";
    addMessage("assistant", message);
    renderTrace(["The request could not be completed. Check your connection and try again."]);
    sourceUsed.textContent = "Request failed";
    if (!question.value.trim()) {
      question.value = value;
      resizeQuestion();
    }
  } finally {
    requestPending = false;
    sendButton.disabled = false;
    question.disabled = false;
    document.querySelectorAll(".example").forEach((button) => {
      button.disabled = false;
    });
    if (!activeModal) question.focus();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  askAgent(question.value);
});

question.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

question.addEventListener("input", () => {
  question.setCustomValidity("");
  resizeQuestion();
});

document.getElementById("toggleGroqKey").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const showing = groqApiKey.type === "password";
  groqApiKey.type = showing ? "text" : "password";
  button.textContent = showing ? "Hide" : "Show";
  button.setAttribute("aria-label", `${showing ? "Hide" : "Show"} Groq API key`);
  button.setAttribute("aria-pressed", String(showing));
});

chat.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-answer-action]");
  if (!button) return;

  const message = button.closest(".message");
  if (button.dataset.answerAction === "view" && message.answerData) {
    showAnswerScreen(message.answerData);
  }
});

document.getElementById("copyAnswer").addEventListener("click", async () => {
  const status = document.getElementById("answerActionStatus");
  try {
    await copyAnswer(latestAnswer.answer);
    status.textContent = "Answer copied.";
  } catch {
    status.textContent = "Copy unavailable. Select and copy the answer text.";
  }
});

document.getElementById("exportAnswer").addEventListener("click", () => {
  const report = document.getElementById("printReport");
  const title = document.createElement("h1");
  title.textContent = "AssistIQ answer";
  const questionText = document.createElement("p");
  questionText.className = "print-question";
  questionText.textContent = latestAnswer.question;
  const source = document.createElement("p");
  source.className = "print-source";
  source.textContent = `Source: ${latestAnswer.source}`;
  const answerContent = document.getElementById("answerContent").cloneNode(true);
  const citations = document.getElementById("answerCitations");
  report.replaceChildren(title, questionText, source, answerContent);
  if (!citations.classList.contains("hidden")) {
    report.append(citations.cloneNode(true));
  }
  window.print();
});

function resizeQuestion() {
  question.style.height = "auto";
  question.style.height = `${Math.min(question.scrollHeight, 150)}px`;
}

document.querySelectorAll(".example").forEach((button) => {
  button.addEventListener("click", () => askAgent(button.textContent.trim()));
});

let drawerTrigger = null;

function updateDrawerAccessibility() {
  if (!sidebarBreakpoint.matches) sidebar.classList.remove("open");
  if (!activityBreakpoint.matches) tracePanel.classList.remove("open");
  const sidebarClosed = sidebarBreakpoint.matches && !sidebar.classList.contains("open");
  const activityClosed = activityBreakpoint.matches && !tracePanel.classList.contains("open");
  sidebar.inert = sidebarClosed;
  sidebar.setAttribute("aria-hidden", String(sidebarClosed));
  tracePanel.inert = activityClosed;
  tracePanel.setAttribute("aria-hidden", String(activityClosed));
  openMenuButton.setAttribute(
    "aria-expanded",
    String(sidebarBreakpoint.matches && sidebar.classList.contains("open")),
  );
  openTraceButton.setAttribute(
    "aria-expanded",
    String(activityBreakpoint.matches && tracePanel.classList.contains("open")),
  );
  const drawerOpen =
    (sidebarBreakpoint.matches && !sidebarClosed) ||
    (activityBreakpoint.matches && !activityClosed);
  if (!drawerOpen) {
    scrim.classList.remove("show");
    drawerTrigger = null;
  }
}

function closeDrawers(restoreFocus = true) {
  const trigger = drawerTrigger;
  sidebar.classList.remove("open");
  tracePanel.classList.remove("open");
  scrim.classList.remove("show");
  drawerTrigger = null;
  updateDrawerAccessibility();
  if (restoreFocus && trigger?.isConnected) trigger.focus();
}

function openDrawer(element, trigger) {
  if (element === tracePanel && !activityBreakpoint.matches) return;
  const wasOpen = element.classList.contains("open");
  closeDrawers(false);
  if (wasOpen) {
    trigger.focus();
    return;
  }
  drawerTrigger = trigger;
  element.classList.add("open");
  scrim.classList.add("show");
  updateDrawerAccessibility();
  element.querySelector("a[href], button:not(:disabled), [tabindex='-1']")?.focus({
    preventScroll: true,
  });
}

openMenuButton.addEventListener("click", () => openDrawer(sidebar, openMenuButton));
openTraceButton.addEventListener("click", () => openDrawer(tracePanel, openTraceButton));
scrim.addEventListener("click", () => closeDrawers());
document.getElementById("closeTrace").addEventListener("click", () => closeDrawers());
window.addEventListener("resize", updateDrawerAccessibility);
updateDrawerAccessibility();

const openUploadButton = document.getElementById("openUpload");
const closeUploadButton = document.getElementById("closeUpload");

function openModal(target, focusTarget) {
  previousFocus = document.activeElement;
  activeModal = target;
  closeDrawers(false);
  document.body.classList.add("modal-open");
  appShell.inert = true;
  target.classList.remove("hidden");
  focusTarget.focus();
}

function closeModal(target = activeModal) {
  if (!target || target !== activeModal) return;
  target.classList.add("hidden");
  activeModal = null;
  appShell.inert = false;
  document.body.classList.remove("modal-open");
  if (previousFocus?.isConnected && !previousFocus.closest("[inert]")) {
    previousFocus.focus();
  } else {
    (sidebarBreakpoint.matches ? openMenuButton : openUploadButton).focus();
  }
}

openUploadButton.addEventListener("click", () => {
  openModal(modal, document.getElementById("adminKey"));
});
closeUploadButton.addEventListener("click", () => closeModal(modal));
document.getElementById("closeAnswer").addEventListener("click", () => closeModal(answerModal));
modal.addEventListener("click", (event) => {
  if (event.target === modal) closeModal(modal);
});
answerModal.addEventListener("click", (event) => {
  if (event.target === answerModal) closeModal(answerModal);
});
document.addEventListener("keydown", (event) => {
  if (activeModal) {
    if (event.key === "Escape") {
      closeModal(activeModal);
      event.preventDefault();
      return;
    }
    if (event.key === "Tab") {
      const focusable = [
        ...activeModal.querySelectorAll(
          "button:not(:disabled), input:not(:disabled), [href], textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
        ),
      ].filter((element) => !element.hidden);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    return;
  }
  if (event.key === "Escape") {
    closeDrawers();
  }
});

uploadButton.addEventListener("click", async () => {
  const fileInput = document.getElementById("fileInput");
  const keyInput = document.getElementById("adminKey");
  const file = fileInput.files?.[0];
  const key = keyInput.value.trim();

  if (!key) {
    setUploadStatus("Enter the document admin key to continue.", "error");
    keyInput.focus();
    return;
  }
  if (!file) {
    setUploadStatus("Choose a PDF, TXT, Markdown, or DOCX file first.", "error");
    fileInput.focus();
    return;
  }
  if (!/\.(pdf|txt|md|docx)$/i.test(file.name)) {
    setUploadStatus(
      "That file type is not supported. Choose a PDF, TXT, Markdown, or DOCX file.",
      "error",
    );
    return;
  }
  const maxUploadSize = Number(uploadLimit.dataset.maxBytes);
  if (file.size === 0) {
    setUploadStatus("The selected document is empty. Choose a file with content.", "error");
    return;
  }
  if (Number.isSafeInteger(maxUploadSize) && maxUploadSize > 0 && file.size > maxUploadSize) {
    setUploadStatus(
      `The selected file exceeds the ${formatFileSize(maxUploadSize)} upload limit.`,
      "error",
    );
    return;
  }

  setUploadStatus("Uploading and indexing your document…");
  uploadButton.disabled = true;
  const formData = new FormData();
  formData.append("file", file);

  try {
    const response = await fetch("/api/ingest", {
      method: "POST",
      headers: { "X-Admin-Key": key },
      body: formData,
    });
    const body = await response.text();
    let data = {};
    if (body) {
      try {
        data = JSON.parse(body);
      } catch {
        throw new Error("The server returned an invalid upload response.");
      }
    }
    if (!response.ok) {
      throw new Error(
        typeof data?.detail === "string" ? data.detail : `Upload failed (HTTP ${response.status}).`,
      );
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("The server returned an invalid upload response.");
    }
    if (
      typeof data.file !== "string" ||
      !data.file ||
      !Number.isSafeInteger(data.chunks) ||
      data.chunks < 0
    ) {
      throw new Error("The server returned an invalid upload response.");
    }
    setUploadStatus(
      `Indexed ${data.file || file.name}: ${data.chunks} chunks added to your knowledge base.`,
      "success",
    );
    fileInput.value = "";
  } catch (error) {
    const message =
      error instanceof TypeError
        ? "Couldn't reach AssistIQ. Check your connection and try again."
        : error instanceof Error
          ? error.message
          : "Upload failed. Please try again.";
    setUploadStatus(message, "error");
  } finally {
    uploadButton.disabled = false;
  }
});

loadReadiness();

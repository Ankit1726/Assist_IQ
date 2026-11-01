const chat = document.getElementById("chat");
const form = document.getElementById("chatForm");
const question = document.getElementById("question");
const trace = document.getElementById("trace");
const sourceUsed = document.getElementById("sourceUsed");
const sidebar = document.getElementById("sidebar");
const tracePanel = document.getElementById("tracePanel");
const scrim = document.getElementById("scrim");
const modal = document.getElementById("uploadModal");
const sendButton = document.getElementById("sendButton");
const uploadButton = document.getElementById("uploadBtn");

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
  const avatar = role === "assistant" ? '<div class="avatar" aria-hidden="true">A</div>' : "";

  wrapper.innerHTML = `${avatar}<div class="bubble">${formatText(text)}${sourceHtml}${citationsHtml}</div>`;
  chat.appendChild(wrapper);
  scrollDown();
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

function renderIntegrations(status) {
  const appStatus = document.getElementById("appStatus");
  const summary = document.getElementById("integrationSummary");
  const list = document.getElementById("integrationList");
  const checks = status?.checks;

  if (!checks || typeof checks !== "object") {
    throw new Error("The server returned an invalid setup status.");
  }

  const entries = Object.values(checks);
  const configuredCount = entries.filter((entry) => entry?.configured === true).length;
  const isReady = status.readiness === "ready" && configuredCount === entries.length;
  appStatus.textContent = isReady ? "Ready" : "Setup needed";
  appStatus.className = `setup-pill ${isReady ? "ready" : "needs-setup"}`;
  summary.textContent = isReady
    ? "Required services are configured. Credentials are stored server-side."
    : `${configuredCount} of ${entries.length} required services configured. Add missing keys on the server.`;
  list.innerHTML = entries
    .map((entry) => {
      const configured = entry?.configured === true;
      return `<li class="integration-row"><span class="integration-dot ${configured ? "ready" : ""}"></span><span>${escapeHtml(entry?.label || "Service")}: ${configured ? "configured" : "needs setup"}</span></li>`;
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

  chat.querySelector(".welcome-block")?.remove();
  chat.querySelector(".welcome-message")?.remove();
  addMessage("user", value);
  question.value = "";
  question.style.height = "auto";
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
      headers: { "Content-Type": "application/json", Accept: "application/json" },
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
        typeof data.detail === "string"
          ? data.detail
          : `The assistant service is temporarily unavailable (HTTP ${response.status}). Please try again shortly.`;
      throw new Error(message);
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
    addMessage(
      "assistant",
      data.answer,
      sourceLabels[data.source_used] || data.source_used || "Source not specified",
      Array.isArray(data.citations) ? data.citations : [],
    );
    renderTrace(data.trace);
    sourceUsed.textContent = sourceLabels[data.source_used] || data.source_used || "Not specified";
  } catch (error) {
    hideTyping();
    const message = error instanceof Error ? error.message : "The request failed. Please try again.";
    addMessage("assistant", message);
    renderTrace(["The request could not be completed. Check your connection and try again."]);
    sourceUsed.textContent = "Request failed";
  } finally {
    requestPending = false;
    sendButton.disabled = false;
    question.disabled = false;
    document.querySelectorAll(".example").forEach((button) => {
      button.disabled = false;
    });
    question.focus();
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
  question.style.height = "auto";
  question.style.height = `${Math.min(question.scrollHeight, 150)}px`;
});

document.querySelectorAll(".example").forEach((button) => {
  button.addEventListener("click", () => askAgent(button.textContent.trim()));
});

function closeDrawers() {
  sidebar.classList.remove("open");
  tracePanel.classList.remove("open");
  scrim.classList.remove("show");
}

function openDrawer(element) {
  closeDrawers();
  element.classList.add("open");
  scrim.classList.add("show");
}

document.getElementById("openMenu").addEventListener("click", () => openDrawer(sidebar));
document.getElementById("openTrace").addEventListener("click", () => openDrawer(tracePanel));
scrim.addEventListener("click", closeDrawers);

const openUploadButton = document.getElementById("openUpload");
const closeUploadButton = document.getElementById("closeUpload");
let previousFocus = null;

function closeUploadModal() {
  modal.classList.add("hidden");
  previousFocus?.focus();
}

openUploadButton.addEventListener("click", () => {
  closeDrawers();
  previousFocus = document.activeElement;
  modal.classList.remove("hidden");
  document.getElementById("adminKey").focus();
});
closeUploadButton.addEventListener("click", closeUploadModal);
modal.addEventListener("click", (event) => {
  if (event.target === modal) closeUploadModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeDrawers();
    if (!modal.classList.contains("hidden")) closeUploadModal();
  }
});

uploadButton.addEventListener("click", async () => {
  const fileInput = document.getElementById("fileInput");
  const keyInput = document.getElementById("adminKey");
  const status = document.getElementById("uploadStatus");
  const file = fileInput.files?.[0];
  const key = keyInput.value.trim();

  if (!key) {
    status.textContent = "Enter the document admin key to continue.";
    keyInput.focus();
    return;
  }
  if (!file) {
    status.textContent = "Choose a PDF, TXT, Markdown, or DOCX file first.";
    fileInput.focus();
    return;
  }
  if (!/\.(pdf|txt|md|docx)$/i.test(file.name)) {
    status.textContent = "That file type is not supported. Choose a PDF, TXT, Markdown, or DOCX file.";
    return;
  }

  status.textContent = "Uploading and indexing your document…";
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
      throw new Error(typeof data.detail === "string" ? data.detail : `Upload failed (HTTP ${response.status}).`);
    }
    status.textContent = `Indexed ${data.file || file.name}: ${data.chunks} chunks added to your knowledge base.`;
    fileInput.value = "";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Upload failed. Please try again.";
  } finally {
    uploadButton.disabled = false;
  }
});

loadReadiness();

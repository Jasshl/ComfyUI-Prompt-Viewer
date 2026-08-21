import { app } from "../../scripts/app.js";

let currentView = "grid"; // "list" or "grid"
let debugMode = false;
let currentImages = [];
let currentSubfolder = "";
const promptCache = {}; // "mode:fields:order:subfolder/filename" -> prompts
const FIELD_SETTINGS_KEY = "comfyui_prompt_viewer_fields_v2";
const FOLDER_SETTINGS_KEY = "comfyui_prompt_viewer_folders_v1";
const LAUNCHER_POSITION_KEY = "comfyui_prompt_viewer_launcher_position_v1";
const OPEN_COMMAND_ID = "PromptViewer.Open";
const SIDEBAR_ID = "prompt-viewer";

// Field settings: { fields: [...], filters: {...}, hideBypassedPrompts: boolean }
let fieldSettings = loadFieldSettings();
let folderSettings = loadFolderSettings();
let detectedSubfolders = [""];

const DEFAULT_FIELD_FILTERS = {
  includeInactive: false,
  includeTechnical: false,
};

const TECHNICAL_NODE_TERMS = [
  "bookmark",
  "imagecache",
  "ksampler",
  "loadimage",
  "loader",
  "note",
  "previewimage",
  "randomnoise",
  "resolutionselector",
  "sampler",
  "saveimage",
  "scheduler",
  "stylemodelapply",
  "tasmartllm",
  "visionencode",
];

const TECHNICAL_TITLE_WORDS = new Set([
  "checkpoint",
  "device",
  "filename",
  "height",
  "model",
  "precision",
  "prefix",
  "resolution",
  "sampler",
  "scheduler",
  "seed",
  "width",
]);

const PROMPT_IDENTITY_TERMS = [
  "caption",
  "description",
  "instruction",
  "llm",
  "prompt",
  "string",
  "text",
];

function normalizeFieldSettings(value) {
  if (!value || !Array.isArray(value.fields)) return null;
  return {
    ...value,
    hideBypassedPrompts: value.hideBypassedPrompts === true,
    filters: {
      includeInactive: value.filters?.includeInactive === true,
      includeTechnical: value.filters?.includeTechnical === true,
    },
  };
}

function loadFieldSettings() {
  try {
    const raw = localStorage.getItem(FIELD_SETTINGS_KEY);
    if (raw) return normalizeFieldSettings(JSON.parse(raw));
  } catch (e) {}
  return null;
}

function ensureFieldSettings() {
  if (!fieldSettings) {
    fieldSettings = {
      fields: [],
      filters: { ...DEFAULT_FIELD_FILTERS },
      hideBypassedPrompts: false,
    };
  } else if (!fieldSettings.filters) {
    fieldSettings.filters = { ...DEFAULT_FIELD_FILTERS };
  }
  return fieldSettings;
}

function saveFieldSettings() {
  localStorage.setItem(FIELD_SETTINGS_KEY, JSON.stringify(fieldSettings));
}

function isInactiveField(field) {
  return field.node_status === "bypassed" || field.node_status === "muted";
}

function isLikelyPromptField(field) {
  if (typeof field.likely_prompt === "boolean") return field.likely_prompt;

  const normalizedType = String(field.node_type || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  const normalizedTitle = String(field.node_title || field.label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  const titleWords = normalizedTitle.split(/\s+/).filter(Boolean);

  if (TECHNICAL_NODE_TERMS.some((term) => normalizedType.includes(term))) return false;
  if (titleWords.some((word) => TECHNICAL_TITLE_WORDS.has(word))) return false;

  const identity = `${normalizedType} ${normalizedTitle.replaceAll(" ", "")}`;
  if (PROMPT_IDENTITY_TERMS.some((term) => identity.includes(term))) return true;

  const example = String(field.example || "").trim();
  const words = example.match(/\b[\w'-]+\b/g) || [];
  return example.length >= 30 && words.length >= 5;
}

function visibleFieldEntries() {
  const settings = ensureFieldSettings();
  return settings.fields
    .map((field, index) => ({ field, index }))
    .filter(({ field }) => (
      (settings.filters.includeInactive || !isInactiveField(field))
      && (settings.filters.includeTechnical || isLikelyPromptField(field))
    ));
}

function loadFolderSettings() {
  try {
    const value = JSON.parse(localStorage.getItem(FOLDER_SETTINGS_KEY));
    return {
      added: Array.isArray(value?.added) ? value.added : [],
      hidden: Array.isArray(value?.hidden) ? value.hidden : [],
    };
  } catch (e) {
    return { added: [], hidden: [] };
  }
}

function saveFolderSettings() {
  try {
    localStorage.setItem(FOLDER_SETTINGS_KEY, JSON.stringify(folderSettings));
  } catch (e) {}
}

function getActiveFieldKeys() {
  if (!fieldSettings) return null;
  return fieldSettings.fields.filter((f) => f.enabled).map((f) => f.key);
}

function getFieldOrder() {
  if (!fieldSettings) return null;
  return fieldSettings.fields.filter((f) => f.enabled).map((f) => f.key);
}

function clearPromptCache() {
  Object.keys(promptCache).forEach((k) => delete promptCache[k]);
}

function shouldHideBypassedPrompts() {
  return ensureFieldSettings().hideBypassedPrompts === true;
}

app.registerExtension({
  name: "PromptViewer",

  commands: [
    {
      id: OPEN_COMMAND_ID,
      label: "Open Prompt Viewer",
      menubarLabel: "Prompt Viewer",
      tooltip: "Browse output images and their prompt metadata",
      icon: "pi pi-images",
      function: openViewer,
    },
  ],

  menuCommands: [
    {
      path: ["View"],
      commands: [OPEN_COMMAND_ID],
    },
  ],

  async setup() {
    if (typeof app.extensionManager?.registerSidebarTab === "function") {
      const tabs = app.extensionManager.getSidebarTabs?.() || [];
      if (!tabs.some((tab) => tab.id === SIDEBAR_ID)) {
        app.extensionManager.registerSidebarTab({
          id: SIDEBAR_ID,
          icon: "pi pi-images",
          title: "Prompt Viewer",
          tooltip: "Prompt Viewer",
          type: "custom",
          render: renderSidebar,
        });
      }
      return;
    }

    installFallbackLauncher();
  },
});

function renderSidebar(container) {
  container.replaceChildren();
  requestAnimationFrame(() => {
    if (!container.isConnected) return;
    openViewer();
    try {
      const result = app.extensionManager.command.execute(
        `Workspace.ToggleSidebarTab.${SIDEBAR_ID}`
      );
      result?.catch?.(() => {});
    } catch (e) {}
  });
}

function installFallbackLauncher() {
  if (document.getElementById("pv-launcher")) return;

  const btn = document.createElement("button");
  btn.id = "pv-launcher";
  btn.type = "button";
  btn.textContent = "Prompt Viewer";
  btn.title = "Open Prompt Viewer (drag to move)";
  btn.style.cssText =
    "position:fixed;top:72px;right:16px;z-index:99999;font-size:13px;padding:6px 14px;border-radius:4px;border:1px solid #555;background:#333;color:#eee;cursor:grab;touch-action:none;";
  document.body.appendChild(btn);

  const clampPosition = (left, top) => ({
    left: Math.max(8, Math.min(left, window.innerWidth - btn.offsetWidth - 8)),
    top: Math.max(8, Math.min(top, window.innerHeight - btn.offsetHeight - 8)),
  });

  const setPosition = (left, top) => {
    const position = clampPosition(left, top);
    btn.style.left = `${position.left}px`;
    btn.style.top = `${position.top}px`;
    btn.style.right = "auto";
    return position;
  };

  try {
    const saved = JSON.parse(localStorage.getItem(LAUNCHER_POSITION_KEY));
    if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
      setPosition(saved.left, saved.top);
    }
  } catch (e) {}

  let drag = null;
  let suppressClick = false;

  btn.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const rect = btn.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    btn.setPointerCapture(event.pointerId);
    btn.style.cursor = "grabbing";
  });

  btn.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (drag.moved) setPosition(drag.left + dx, drag.top + dy);
  });

  btn.addEventListener("pointerup", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    btn.releasePointerCapture(event.pointerId);
    btn.style.cursor = "grab";
    if (drag.moved) {
      const rect = btn.getBoundingClientRect();
      try {
        localStorage.setItem(
          LAUNCHER_POSITION_KEY,
          JSON.stringify({ left: rect.left, top: rect.top })
        );
      } catch (e) {}
      suppressClick = true;
    }
    drag = null;
  });

  btn.addEventListener("click", () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    openViewer();
  });

  window.addEventListener("resize", () => {
    const rect = btn.getBoundingClientRect();
    if (btn.style.left) setPosition(rect.left, rect.top);
  });
}

async function fetchPrompts(filename, subfolder) {
  const activeKeys = debugMode ? null : getActiveFieldKeys();
  const order = debugMode ? null : getFieldOrder();
  const mode = debugMode ? "debug" : (activeKeys ? "custom" : "clean");
  const fieldsParam = activeKeys ? activeKeys.join(",") : "";
  const orderParam = order ? order.join(",") : "";
  const hideBypassed = shouldHideBypassedPrompts();
  const key = `${mode}:${hideBypassed}:${fieldsParam}:${orderParam}:${subfolder}/${filename}`;
  if (promptCache[key]) return promptCache[key];
  try {
    let url = `/history_tools/prompt_viewer/prompts?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&mode=${mode}`;
    if (fieldsParam) url += `&fields=${encodeURIComponent(fieldsParam)}`;
    if (orderParam) url += `&order=${encodeURIComponent(orderParam)}`;
    if (hideBypassed) url += "&hide_bypassed=true";
    const resp = await fetch(url);
    const prompts = await resp.json();
    promptCache[key] = prompts;
    return prompts;
  } catch (e) {
    console.error("Prompt Viewer: failed to load prompts for", filename, e);
    return [];
  }
}

async function openViewer() {
  const existing = document.getElementById("prompt-viewer-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "prompt-viewer-overlay";
  overlay.innerHTML = buildShell();
  document.body.appendChild(overlay);

  applyStyles(overlay);

  overlay.querySelector("#pv-close").addEventListener("click", () => overlay.remove());

  // Click outside the panel to close
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  overlay.querySelector("#pv-view-list").addEventListener("click", () => {
    currentView = "list";
    updateViewToggle(overlay);
    rerenderGrid(overlay);
  });
  overlay.querySelector("#pv-view-grid").addEventListener("click", () => {
    currentView = "grid";
    updateViewToggle(overlay);
    rerenderGrid(overlay);
  });

  const debugBtn = overlay.querySelector("#pv-debug");
  debugBtn.classList.toggle("pv-toggle-active", debugMode);
  debugBtn.addEventListener("click", () => {
    debugMode = !debugMode;
    debugBtn.classList.toggle("pv-toggle-active", debugMode);
    clearPromptCache();
    rerenderGrid(overlay);
  });

  overlay.querySelector("#pv-settings").addEventListener("click", () => {
    openSettingsPanel(overlay);
  });
  overlay.querySelector("#pv-folders").addEventListener("click", () => {
    openFoldersPanel(overlay);
  });

  const escHandler = (e) => {
    if (e.key === "Escape") {
      const settings = document.getElementById("pv-settings-panel");
      if (settings) { settings.remove(); return; }
      const folders = document.getElementById("pv-folders-panel");
      if (folders) { folders.remove(); return; }
      const lb = document.getElementById("pv-lightbox");
      if (lb) { lb.remove(); cleanupNav(); return; }
      overlay.remove();
      document.removeEventListener("keydown", escHandler);
    }
  };
  document.addEventListener("keydown", escHandler);

  updateViewToggle(overlay);
  await loadSubfolders(overlay);
  await loadImages(overlay);
}

function buildShell() {
  return `
    <div id="pv-panel">
      <div id="pv-header">
        <h2>Prompt Viewer</h2>
        <div id="pv-controls">
          <div id="pv-view-toggle">
            <button id="pv-view-list" title="List view">&#9776;</button>
            <button id="pv-view-grid" title="Grid view">&#9638;</button>
          </div>
          <select id="pv-subfolder"><option value="">output (root)</option></select>
          <button id="pv-folders" title="Manage output folders" aria-label="Manage output folders"><i class="pi pi-folder-open"></i></button>
          <input id="pv-search" type="text" placeholder="Search prompts &amp; filenames..." />
          <button id="pv-settings" title="Configure visible fields">Fields</button>
          <button id="pv-debug" title="Toggle debug mode (show all metadata)">Debug</button>
          <button id="pv-close">&times;</button>
        </div>
      </div>
      <div id="pv-grid"></div>
    </div>
  `;
}

// ── Folder Panel ──

function normalizeManualFolder(value) {
  const path = value.trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!path || /^[a-zA-Z]:/.test(path)) return null;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

function visibleSubfolders() {
  const hidden = new Set(folderSettings.hidden);
  const folders = new Set([...detectedSubfolders, ...folderSettings.added]);
  return [
    "",
    ...[...folders]
      .filter((folder) => folder && !hidden.has(folder))
      .sort((a, b) => a.localeCompare(b)),
  ];
}

function refreshSubfolderSelect(overlay, preferred = currentSubfolder) {
  const select = overlay.querySelector("#pv-subfolder");
  const folders = visibleSubfolders();
  select.replaceChildren();
  for (const folder of folders) {
    const option = document.createElement("option");
    option.value = folder;
    option.textContent = folder || "output (root)";
    select.appendChild(option);
  }
  select.value = folders.includes(preferred) ? preferred : "";
  return select.value;
}

function createFolderRow(path, checked, onChange, remove) {
  const row = document.createElement("div");
  row.className = "pv-folder-row";

  const label = document.createElement("label");
  const text = document.createElement("span");
  text.textContent = path;
  if (checked !== null) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = checked;
    checkbox.addEventListener("change", () => onChange(checkbox.checked));
    label.append(checkbox, text);
  } else {
    label.appendChild(text);
  }
  row.appendChild(label);

  if (remove) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = `Remove ${path}`;
    button.setAttribute("aria-label", `Remove ${path}`);
    button.innerHTML = '<i class="pi pi-trash"></i>';
    button.addEventListener("click", remove);
    row.appendChild(button);
  }
  return row;
}

function openFoldersPanel(overlay) {
  const existing = document.getElementById("pv-folders-panel");
  if (existing) { existing.remove(); return; }
  document.getElementById("pv-settings-panel")?.remove();

  const panel = document.createElement("div");
  panel.id = "pv-folders-panel";
  panel.innerHTML = `
    <div id="pv-folders-inner">
      <div id="pv-folders-header">
        <h3>Output Folders</h3>
        <button id="pv-folders-close" title="Close" aria-label="Close">&times;</button>
      </div>
      <section class="pv-folder-section">
        <h4>Detected</h4>
        <div id="pv-detected-folders"></div>
      </section>
      <section class="pv-folder-section">
        <h4>Added</h4>
        <div id="pv-added-folders"></div>
        <div class="pv-folder-add">
          <input id="pv-folder-path" type="text" placeholder="relative/path" aria-label="Folder path under output" />
          <button id="pv-folder-add" type="button" title="Add folder" aria-label="Add folder"><i class="pi pi-plus"></i></button>
        </div>
      </section>
    </div>
  `;
  overlay.appendChild(panel);
  panel.querySelector("#pv-folders-close").addEventListener("click", () => panel.remove());

  const renderFolders = () => {
    const detectedList = panel.querySelector("#pv-detected-folders");
    const addedList = panel.querySelector("#pv-added-folders");
    detectedList.replaceChildren();
    addedList.replaceChildren();

    const detected = detectedSubfolders.filter(Boolean);
    if (!detected.length) {
      detectedList.innerHTML = '<p class="pv-folder-empty">No detected folders</p>';
    }
    for (const path of detected) {
      detectedList.appendChild(
        createFolderRow(
          path,
          !folderSettings.hidden.includes(path),
          (visible) => {
            const hidden = new Set(folderSettings.hidden);
            visible ? hidden.delete(path) : hidden.add(path);
            folderSettings.hidden = [...hidden];
            saveFolderSettings();
            const next = refreshSubfolderSelect(overlay);
            if (next !== currentSubfolder) loadImages(overlay);
          }
        )
      );
    }

    if (!folderSettings.added.length) {
      addedList.innerHTML = '<p class="pv-folder-empty">No added folders</p>';
    }
    for (const path of folderSettings.added) {
      addedList.appendChild(
        createFolderRow(path, null, () => {}, () => {
          folderSettings.added = folderSettings.added.filter((item) => item !== path);
          saveFolderSettings();
          const next = refreshSubfolderSelect(overlay);
          if (next !== currentSubfolder) loadImages(overlay);
          renderFolders();
        })
      );
    }
  };

  const addInput = panel.querySelector("#pv-folder-path");
  const addFolder = () => {
    const path = normalizeManualFolder(addInput.value);
    if (!path) {
      addInput.setCustomValidity("Enter a relative path inside the output directory");
      addInput.reportValidity();
      return;
    }
    addInput.setCustomValidity("");
    folderSettings.hidden = folderSettings.hidden.filter((item) => item !== path);
    if (!detectedSubfolders.includes(path) && !folderSettings.added.includes(path)) {
      folderSettings.added.push(path);
      folderSettings.added.sort((a, b) => a.localeCompare(b));
    }
    saveFolderSettings();
    refreshSubfolderSelect(overlay, path);
    loadImages(overlay);
    addInput.value = "";
    renderFolders();
  };

  addInput.addEventListener("input", () => addInput.setCustomValidity(""));
  addInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addFolder();
  });
  panel.querySelector("#pv-folder-add").addEventListener("click", addFolder);
  renderFolders();
}

// ── Settings Panel ──

async function openSettingsPanel(overlay) {
  const existing = document.getElementById("pv-settings-panel");
  if (existing) { existing.remove(); return; }
  document.getElementById("pv-folders-panel")?.remove();

  const panel = document.createElement("div");
  panel.id = "pv-settings-panel";
  panel.innerHTML = `
    <div id="pv-settings-inner">
      <div id="pv-settings-header">
        <h3>Visible Fields</h3>
        <div>
          <button id="pv-settings-scan">Scan for fields</button>
          <button id="pv-settings-close">&times;</button>
        </div>
      </div>
      <p class="pv-settings-hint">Choose the prompt fields to show and drag to reorder them. Scan uses images from the selected output folder.</p>
      <div class="pv-gallery-options">
        <label title="Selected fields stay selected, but are omitted for images where their node was bypassed.">
          <input id="pv-hide-bypassed" type="checkbox" /> Hide bypassed prompts in gallery
        </label>
      </div>
      <div class="pv-field-filters">
        <label><input id="pv-filter-inactive" type="checkbox" /> Include inactive</label>
        <label><input id="pv-filter-technical" type="checkbox" /> Include technical</label>
        <span id="pv-field-count"></span>
      </div>
      <div id="pv-field-list"></div>
    </div>
  `;
  overlay.appendChild(panel);

  const settings = ensureFieldSettings();
  const inactiveFilter = panel.querySelector("#pv-filter-inactive");
  const technicalFilter = panel.querySelector("#pv-filter-technical");
  const hideBypassed = panel.querySelector("#pv-hide-bypassed");
  inactiveFilter.checked = settings.filters.includeInactive;
  technicalFilter.checked = settings.filters.includeTechnical;
  hideBypassed.checked = settings.hideBypassedPrompts;

  panel.querySelector("#pv-settings-close").addEventListener("click", () => panel.remove());
  panel.querySelector("#pv-settings-scan").addEventListener("click", () => scanFields(panel));
  hideBypassed.addEventListener("change", () => {
    settings.hideBypassedPrompts = hideBypassed.checked;
    saveFieldSettings();
    clearPromptCache();
    refreshOpenViewer();
  });
  inactiveFilter.addEventListener("change", () => {
    settings.filters.includeInactive = inactiveFilter.checked;
    saveFieldSettings();
    renderFieldList(panel);
  });
  technicalFilter.addEventListener("change", () => {
    settings.filters.includeTechnical = technicalFilter.checked;
    saveFieldSettings();
    renderFieldList(panel);
  });

  renderFieldList(panel);
}

async function scanFields(panel) {
  const scanBtn = panel.querySelector("#pv-settings-scan");
  scanBtn.textContent = "Scanning...";
  scanBtn.disabled = true;

  try {
    const resp = await fetch(
      `/history_tools/prompt_viewer/discover_fields?subfolder=${encodeURIComponent(currentSubfolder)}&sample=50`
    );
    const discovered = await resp.json();

    const settings = ensureFieldSettings();

    const existingFields = new Map(settings.fields.map((f) => [f.key, f]));
    const discoveredKeys = new Set();
    for (const d of discovered) {
      discoveredKeys.add(d.key);
      const existing = existingFields.get(d.key);
      if (existing) {
        Object.assign(existing, {
          label: d.label,
          node_id: d.node_id,
          node_type: d.node_type,
          node_title: d.node_title,
          widget_index: d.widget_index,
          node_status: d.node_status,
          likely_prompt: d.likely_prompt,
          example: d.example,
          example_source: d.example_source,
        });
      } else {
        settings.fields.push({
          key: d.key,
          label: d.label,
          enabled: false,
          node_id: d.node_id,
          node_type: d.node_type,
          node_title: d.node_title,
          widget_index: d.widget_index,
          node_status: d.node_status,
          likely_prompt: d.likely_prompt,
          example: d.example,
          example_source: d.example_source,
        });
      }
    }
    settings.fields = settings.fields.filter(
      (field) => field.enabled || discoveredKeys.has(field.key)
    );

    saveFieldSettings();
    renderFieldList(panel);
  } catch (e) {
    console.error("Prompt Viewer: scan failed", e);
  }

  scanBtn.textContent = "Scan for fields";
  scanBtn.disabled = false;
}

function renderFieldList(panel) {
  const settings = ensureFieldSettings();
  const list = panel.querySelector("#pv-field-list");
  const count = panel.querySelector("#pv-field-count");
  if (settings.fields.length === 0) {
    count.textContent = "";
    list.innerHTML = '<p class="pv-settings-hint">No fields discovered yet. Click "Scan" to find text fields in your images.</p>';
    return;
  }

  const entries = visibleFieldEntries();
  const visibleIndices = new Set(entries.map(({ index }) => index));
  const hiddenSelected = settings.fields.filter(
    (field, index) => field.enabled && !visibleIndices.has(index)
  ).length;
  count.textContent = `${entries.length} of ${settings.fields.length} fields`;
  if (hiddenSelected) count.textContent += ` (${hiddenSelected} selected hidden)`;

  if (entries.length === 0) {
    list.innerHTML = '<p class="pv-settings-hint">No fields match these filters.</p>';
    return;
  }

  list.innerHTML = entries
    .map(({ field: f, index: i }) => `
      <div class="pv-field-row" data-index="${i}">
        <div class="pv-field-drag">
          <button class="pv-field-up" data-index="${i}" title="Move up">&uarr;</button>
          <button class="pv-field-down" data-index="${i}" title="Move down">&darr;</button>
        </div>
        <label class="pv-field-toggle">
          <input type="checkbox" data-index="${i}" ${f.enabled ? "checked" : ""} />
          <span class="pv-field-copy">
            <span class="pv-field-label">${escapeHtml(f.label)}</span>
            <span class="pv-field-example-source">Sample from ${escapeHtml(f.example_source || "scanned image")}</span>
            <span class="pv-field-example">${escapeHtml(f.example || "")}</span>
          </span>
        </label>
        <span class="pv-field-badges">
          ${isInactiveField(f) ? `<span class="pv-field-status pv-status-${escapeHtml(f.node_status)}">${escapeHtml(f.node_status)}</span>` : ""}
          ${isLikelyPromptField(f) ? "" : '<span class="pv-field-kind">technical</span>'}
        </span>
        <span class="pv-field-key" title="${escapeHtml(f.key)}">#${escapeHtml(f.node_id || "?")}</span>
      </div>
    `)
    .join("");

  // Checkbox toggles
  list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const idx = parseInt(cb.dataset.index);
      settings.fields[idx].enabled = cb.checked;
      saveFieldSettings();
      clearPromptCache();
      refreshOpenViewer();
    });
  });

  // Up/down buttons
  list.querySelectorAll(".pv-field-up").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.index);
      const orderedVisibleIndices = visibleFieldEntries().map(({ index }) => index);
      const position = orderedVisibleIndices.indexOf(idx);
      if (position <= 0) return;
      const previousIdx = orderedVisibleIndices[position - 1];
      const fields = settings.fields;
      [fields[previousIdx], fields[idx]] = [fields[idx], fields[previousIdx]];
      saveFieldSettings();
      clearPromptCache();
      renderFieldList(panel);
      refreshOpenViewer();
    });
  });

  list.querySelectorAll(".pv-field-down").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.index);
      const orderedVisibleIndices = visibleFieldEntries().map(({ index }) => index);
      const position = orderedVisibleIndices.indexOf(idx);
      if (position < 0 || position >= orderedVisibleIndices.length - 1) return;
      const nextIdx = orderedVisibleIndices[position + 1];
      const fields = settings.fields;
      [fields[idx], fields[nextIdx]] = [fields[nextIdx], fields[idx]];
      saveFieldSettings();
      clearPromptCache();
      renderFieldList(panel);
      refreshOpenViewer();
    });
  });
}

// ── View toggle ──

function updateViewToggle(overlay) {
  const listBtn = overlay.querySelector("#pv-view-list");
  const gridBtn = overlay.querySelector("#pv-view-grid");
  listBtn.classList.toggle("pv-toggle-active", currentView === "list");
  gridBtn.classList.toggle("pv-toggle-active", currentView === "grid");
}

function rerenderGrid(overlay) {
  handleSearch(overlay);
}

function refreshOpenViewer() {
  const overlay = document.getElementById("prompt-viewer-overlay");
  if (overlay) rerenderGrid(overlay);
}

async function loadSubfolders(overlay) {
  try {
    const resp = await fetch("/history_tools/prompt_viewer/subfolders");
    const folders = await resp.json();
    detectedSubfolders = folders.filter((folder) => typeof folder === "string");
    const select = overlay.querySelector("#pv-subfolder");
    refreshSubfolderSelect(overlay);
    select.addEventListener("change", () => loadImages(overlay));
  } catch (e) {
    console.error("Prompt Viewer: failed to load subfolders", e);
  }
}

let searchTimeout = null;
let searchController = null;

async function loadImages(overlay) {
  const grid = overlay.querySelector("#pv-grid");
  currentSubfolder = overlay.querySelector("#pv-subfolder").value;
  const search = overlay.querySelector("#pv-search");

  grid.innerHTML = '<p style="color:#aaa;text-align:center;">Loading...</p>';

  try {
    const resp = await fetch(
      `/history_tools/prompt_viewer/images?subfolder=${encodeURIComponent(currentSubfolder)}&limit=200`
    );
    currentImages = await resp.json();
    search.oninput = () => handleSearch(overlay);
    renderContent(grid, currentImages, currentSubfolder);
  } catch (e) {
    grid.innerHTML = '<p style="color:#f66;">Failed to load images.</p>';
    console.error("Prompt Viewer: failed to load images", e);
  }
}

function handleSearch(overlay) {
  const grid = overlay.querySelector("#pv-grid");
  const query = overlay.querySelector("#pv-search").value.trim();

  if (searchTimeout) clearTimeout(searchTimeout);
  if (searchController) searchController.abort();

  if (query.length < 3) {
    const filtered = query
      ? currentImages.filter((img) => img.filename.toLowerCase().includes(query.toLowerCase()))
      : currentImages;
    renderContent(grid, filtered, currentSubfolder);
    return;
  }

  searchTimeout = setTimeout(async () => {
    grid.innerHTML = '<p style="color:#aaa;text-align:center;">Searching prompts...</p>';
    searchController = new AbortController();
    try {
      const activeKeys = debugMode ? null : getActiveFieldKeys();
      const order = debugMode ? null : getFieldOrder();
      const mode = debugMode ? "debug" : (activeKeys ? "custom" : "clean");
      const params = new URLSearchParams({
        q: query,
        subfolder: currentSubfolder,
        mode,
      });
      if (activeKeys) params.set("fields", activeKeys.join(","));
      if (order) params.set("order", order.join(","));
      if (shouldHideBypassedPrompts()) params.set("hide_bypassed", "true");
      const resp = await fetch(`/history_tools/prompt_viewer/search?${params}`, {
        signal: searchController.signal,
      });
      const matchedFiles = await resp.json();
      const matchedNames = new Set(matchedFiles.map((f) => f.filename));
      const filenameMatches = currentImages.filter(
        (img) => img.filename.toLowerCase().includes(query.toLowerCase()) && !matchedNames.has(img.filename)
      );
      const combined = [...matchedFiles, ...filenameMatches];
      renderContent(grid, combined, currentSubfolder);
    } catch (e) {
      if (e.name !== "AbortError") {
        grid.innerHTML = '<p style="color:#f66;">Search failed.</p>';
        console.error("Prompt Viewer: search failed", e);
      }
    }
  }, 400);
}

function renderContent(grid, images, subfolder) {
  if (images.length === 0) {
    grid.innerHTML = '<p style="color:#aaa;text-align:center;">No images found.</p>';
    return;
  }

  if (currentView === "grid") {
    renderGridView(grid, images, subfolder);
  } else {
    renderListView(grid, images, subfolder);
  }
}

// ── List View ──

function renderListView(grid, images, subfolder) {
  grid.className = "pv-list-view";
  grid.innerHTML = images
    .map((img, i) => {
      const src = imgSrc(img.filename, subfolder);
      return `
        <div class="pv-card" data-index="${i}">
          <div class="pv-img-wrap">
            <img class="pv-img" src="${src}" loading="lazy" alt="${escapeHtml(img.filename)}" />
          </div>
          <div class="pv-info">
            <div class="pv-filename">${escapeHtml(img.filename)}</div>
            <div class="pv-prompts pv-prompts-lazy" data-filename="${escapeHtml(img.filename)}">
              <span class="pv-loading-text">Loading prompts...</span>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  grid.querySelectorAll(".pv-img").forEach((imgEl, i) => {
    imgEl.addEventListener("click", () => openLightbox(images, subfolder, i));
  });

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      observer.unobserve(el);
      const filename = el.dataset.filename;
      fetchPrompts(filename, subfolder).then((prompts) => {
        el.innerHTML = prompts.length
          ? prompts.map((p) => buildPromptCard(p)).join("")
          : '<div class="pv-no-prompt">No text prompts found in metadata</div>';
      });
    }
  }, { root: document.getElementById("prompt-viewer-overlay"), rootMargin: "200px" });

  grid.querySelectorAll(".pv-prompts-lazy").forEach((el) => observer.observe(el));
}

// ── Grid View ──

function renderGridView(grid, images, subfolder) {
  grid.className = "pv-grid-view";
  grid.innerHTML = images
    .map((img, i) => {
      const src = imgSrc(img.filename, subfolder);
      return `
        <div class="pv-tile" data-index="${i}">
          <img class="pv-tile-img" src="${src}" loading="lazy" alt="${escapeHtml(img.filename)}" />
          <div class="pv-tile-name">${escapeHtml(img.filename)}</div>
        </div>
      `;
    })
    .join("");

  // Store images for navigation
  navImages = images;
  navSubfolder = subfolder;

  grid.querySelectorAll(".pv-tile").forEach((tile) => {
    tile.addEventListener("click", async () => {
      const idx = parseInt(tile.dataset.index);
      const img = images[idx];
      const src = imgSrc(img.filename, subfolder);
      setupNav(images, subfolder, idx, "detail");
      openDetailPanel(img, src, subfolder, idx, true);
    });
  });
}

// ── Navigation state for lightbox/detail ──

let navImages = [];
let navSubfolder = "";
let navIndex = 0;
let navMode = ""; // "lightbox" or "detail"
let navKeyHandler = null;

function setupNav(images, subfolder, index, mode) {
  navImages = images;
  navSubfolder = subfolder;
  navIndex = index;
  navMode = mode;

  if (navKeyHandler) document.removeEventListener("keydown", navKeyHandler);
  navKeyHandler = (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      navigateTo(navIndex - 1);
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      navigateTo(navIndex + 1);
    }
  };
  document.addEventListener("keydown", navKeyHandler);
}

function cleanupNav() {
  if (navKeyHandler) {
    document.removeEventListener("keydown", navKeyHandler);
    navKeyHandler = null;
  }
}

function navigateTo(newIndex) {
  if (newIndex < 0 || newIndex >= navImages.length) return;
  navIndex = newIndex;
  const img = navImages[navIndex];
  const src = imgSrc(img.filename, navSubfolder);
  if (navMode === "lightbox") {
    updateLightbox(src, navIndex);
  } else {
    openDetailPanel(img, src, navSubfolder, navIndex, true);
  }
}

// ── Lightbox ──

function openLightbox(images, subfolder, index) {
  const existing = document.getElementById("pv-lightbox");
  if (existing) existing.remove();

  setupNav(images, subfolder, index, "lightbox");
  const src = imgSrc(images[index].filename, subfolder);

  const lb = document.createElement("div");
  lb.id = "pv-lightbox";
  lb.innerHTML = `
    <div id="pv-lb-backdrop">
      <button class="pv-nav-arrow pv-nav-left">&lsaquo;</button>
      <img id="pv-lb-img" src="${src}" />
      <button class="pv-nav-arrow pv-nav-right">&rsaquo;</button>
      <button id="pv-lb-close">&times;</button>
      <div id="pv-lb-counter">${index + 1} / ${images.length}</div>
    </div>
  `;
  document.body.appendChild(lb);

  lb.querySelector("#pv-lb-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "pv-lb-backdrop" || e.target.id === "pv-lb-close") {
      lb.remove();
      cleanupNav();
    }
  });
  lb.querySelector(".pv-nav-left").addEventListener("click", (e) => { e.stopPropagation(); navigateTo(navIndex - 1); });
  lb.querySelector(".pv-nav-right").addEventListener("click", (e) => { e.stopPropagation(); navigateTo(navIndex + 1); });
}

function updateLightbox(src, index) {
  const img = document.getElementById("pv-lb-img");
  const counter = document.getElementById("pv-lb-counter");
  if (img) img.src = src;
  if (counter) counter.textContent = `${index + 1} / ${navImages.length}`;
}

// ── Detail Panel ──

async function openDetailPanel(img, src, subfolder, index, skipSetup) {
  const existing = document.getElementById("pv-lightbox");
  if (existing) existing.remove();

  if (!skipSetup) {
    // Find the index in the current filtered image list
    const images = navImages.length ? navImages : currentImages;
    const idx = images.findIndex((i) => i.filename === img.filename);
    setupNav(images, subfolder, idx >= 0 ? idx : 0, "detail");
  }

  const lb = document.createElement("div");
  lb.id = "pv-lightbox";
  lb.innerHTML = `
    <div id="pv-lb-backdrop">
      <button class="pv-nav-arrow pv-nav-left">&lsaquo;</button>
      <button class="pv-nav-arrow pv-nav-right">&rsaquo;</button>
      <button id="pv-lb-close">&times;</button>
      <div id="pv-lb-counter">${navIndex + 1} / ${navImages.length}</div>
      <div id="pv-detail">
        <img id="pv-detail-img" src="${src}" />
        <div id="pv-detail-info">
          <div class="pv-filename">${escapeHtml(img.filename)}</div>
          <div class="pv-prompts">
            <span class="pv-loading-text">Loading prompts...</span>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(lb);

  lb.querySelector("#pv-lb-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "pv-lb-backdrop" || e.target.id === "pv-lb-close") {
      lb.remove();
      cleanupNav();
    }
  });
  lb.querySelector(".pv-nav-left").addEventListener("click", (e) => { e.stopPropagation(); navigateTo(navIndex - 1); });
  lb.querySelector(".pv-nav-right").addEventListener("click", (e) => { e.stopPropagation(); navigateTo(navIndex + 1); });

  const prompts = await fetchPrompts(img.filename, subfolder);
  const promptsEl = lb.querySelector(".pv-prompts");
  if (promptsEl) {
    promptsEl.innerHTML = prompts.length
      ? prompts.map((p) => buildPromptCard(p)).join("")
      : '<div class="pv-no-prompt">No text prompts found in metadata</div>';
  }
}

// ── Helpers ──

function imgSrc(filename, subfolder) {
  return `/view?filename=${encodeURIComponent(filename)}&type=output&subfolder=${encodeURIComponent(subfolder)}`;
}

function buildPromptCard(p) {
  const status = p.node_status && p.node_status !== "active"
    ? `<span class="pv-prompt-status pv-status-${escapeHtml(p.node_status)}">${escapeHtml(p.node_status)}</span>`
    : "";
  return `
    <div class="pv-prompt-card">
      <div class="pv-prompt-header">
        <div class="pv-prompt-label">${escapeHtml(p.label)}</div>
        ${status}
      </div>
      <div class="pv-prompt-text">${escapeHtml(p.text)}</div>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Styles ──

function applyStyles(overlay) {
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 100000;
    background: rgba(0,0,0,0.85); overflow: auto;
  `;

  const style = document.createElement("style");
  style.textContent = `
    #pv-panel {
      max-width: 1400px; margin: 20px auto; padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #eee;
    }
    #pv-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 20px; flex-wrap: wrap; gap: 10px;
    }
    #pv-header h2 { margin: 0; font-size: 20px; }
    #pv-controls {
      max-width: 100%; display: flex; gap: 8px; align-items: center;
      justify-content: flex-end; flex-wrap: wrap;
    }
    #pv-view-toggle { display: flex; gap: 2px; }
    #pv-view-toggle button {
      padding: 4px 10px; border-radius: 4px; border: 1px solid #555;
      background: #222; color: #888; cursor: pointer; font-size: 14px;
    }
    #pv-view-toggle button.pv-toggle-active {
      background: #444; color: #eee; border-color: #777;
    }
    #pv-subfolder, #pv-search {
      padding: 6px 10px; border-radius: 4px; border: 1px solid #555;
      background: #222; color: #eee; font-size: 13px;
    }
    #pv-search { width: 200px; }
    #pv-folders, #pv-settings, #pv-debug {
      padding: 4px 10px; border-radius: 4px; border: 1px solid #555;
      background: #222; color: #888; cursor: pointer; font-size: 12px;
    }
    #pv-folders { width: 30px; height: 30px; flex: 0 0 30px; padding: 0; }
    #pv-folders:hover, #pv-settings:hover, #pv-debug:hover { background: #333; color: #bbb; }
    #pv-debug.pv-toggle-active {
      background: #553322; color: #ffaa66; border-color: #885533;
    }
    #pv-close {
      font-size: 22px; background: none; border: none; color: #eee;
      cursor: pointer; padding: 0 8px; line-height: 1;
    }

    .pv-loading-text {
      color: #666; font-size: 13px; font-style: italic;
    }

    /* ── Side Panels ── */
    #pv-settings-panel, #pv-folders-panel {
      position: fixed; top: 0; right: 0; width: min(420px, 100vw); height: 100%;
      background: #1a1a1a; border-left: 1px solid #444; z-index: 150000;
      overflow: auto; box-shadow: -4px 0 20px rgba(0,0,0,0.5);
    }
    #pv-settings-inner, #pv-folders-inner { padding: 20px; }
    #pv-settings-header, #pv-folders-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 12px;
    }
    #pv-settings-header h3, #pv-folders-header h3 {
      margin: 0; font-size: 16px; color: #eee;
    }
    #pv-settings-header button, #pv-folders-header button {
      padding: 4px 10px; border-radius: 4px; border: 1px solid #555;
      background: #222; color: #ccc; cursor: pointer; font-size: 12px;
      margin-left: 6px;
    }
    #pv-settings-header button:hover, #pv-folders-header button:hover { background: #333; }
    .pv-settings-hint {
      font-size: 12px; color: #777; margin: 0 0 16px 0; line-height: 1.4;
    }
    .pv-gallery-options {
      padding: 0 8px 10px; border-bottom: 1px solid #303030;
    }
    .pv-gallery-options label {
      display: flex; align-items: center; gap: 6px;
      color: #ccc; font-size: 12px; cursor: pointer;
    }
    .pv-gallery-options input { margin: 0; cursor: pointer; }
    .pv-field-filters {
      display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px;
      min-height: 32px; padding: 7px 8px; margin-bottom: 10px;
      border-bottom: 1px solid #303030;
    }
    .pv-field-filters label {
      display: flex; align-items: center; gap: 6px;
      color: #bbb; font-size: 12px; cursor: pointer;
    }
    .pv-field-filters input { margin: 0; cursor: pointer; }
    #pv-field-count {
      margin-left: auto; color: #777; font-size: 11px; white-space: nowrap;
    }

    .pv-field-row {
      display: flex; align-items: center; gap: 8px;
      padding: 8px; margin-bottom: 4px; background: #222;
      border-radius: 6px; border: 1px solid #333;
    }
    .pv-field-drag { display: flex; flex-direction: column; gap: 1px; }
    .pv-field-drag button {
      background: none; border: 1px solid #444; color: #888;
      cursor: pointer; padding: 1px 5px; font-size: 11px;
      border-radius: 3px; line-height: 1;
    }
    .pv-field-drag button:hover { color: #eee; border-color: #777; }
    .pv-field-toggle {
      display: flex; align-items: flex-start; gap: 6px; flex: 1;
      cursor: pointer; min-width: 0;
    }
    .pv-field-toggle input { cursor: pointer; flex-shrink: 0; margin-top: 2px; }
    .pv-field-copy {
      display: flex; flex-direction: column; gap: 3px; min-width: 0;
    }
    .pv-field-label {
      font-size: 13px; color: #ddd;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .pv-field-example {
      color: #777; font-size: 11px; line-height: 1.35;
      display: -webkit-box; -webkit-box-orient: vertical;
      -webkit-line-clamp: 2; overflow: hidden; word-break: break-word;
    }
    .pv-field-example-source {
      color: #999; font-size: 10px; line-height: 1.2;
      font-family: monospace; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    .pv-field-key {
      font-size: 10px; color: #555; font-family: monospace;
      white-space: nowrap; flex-shrink: 0;
    }
    .pv-field-badges {
      display: flex; flex-direction: column; align-items: flex-end;
      gap: 4px; flex-shrink: 0;
    }
    .pv-field-status, .pv-prompt-status {
      font-size: 10px; line-height: 1; text-transform: uppercase;
      color: #aaa; white-space: nowrap;
    }
    .pv-field-kind {
      color: #7c8797; font-size: 9px; line-height: 1;
      text-transform: uppercase; white-space: nowrap;
    }
    .pv-status-muted { color: #d6a85f; }
    .pv-status-bypassed { color: #d78383; }

    .pv-folder-section { margin-top: 20px; }
    .pv-folder-section h4 {
      margin: 0 0 8px; color: #999; font-size: 11px;
      font-weight: 600; text-transform: uppercase;
    }
    .pv-folder-row {
      min-height: 36px; display: flex; align-items: center; gap: 8px;
      padding: 6px 8px; border-bottom: 1px solid #303030;
    }
    .pv-folder-row label {
      min-width: 0; flex: 1; display: flex; align-items: center;
      gap: 8px; color: #ccc; cursor: pointer;
    }
    .pv-folder-row label span {
      min-width: 0; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; font: 12px/1.3 monospace;
    }
    .pv-folder-row button, .pv-folder-add button {
      width: 30px; height: 30px; flex: 0 0 30px; padding: 0;
      border: 1px solid #444; border-radius: 4px;
      background: #222; color: #aaa; cursor: pointer;
    }
    .pv-folder-row button:hover, .pv-folder-add button:hover {
      background: #333; color: #eee;
    }
    .pv-folder-add { display: flex; gap: 6px; margin-top: 10px; }
    .pv-folder-add input {
      min-width: 0; flex: 1; height: 30px; box-sizing: border-box;
      padding: 0 8px; border: 1px solid #555; border-radius: 4px;
      background: #222; color: #eee; font: 12px/1.3 monospace;
    }
    .pv-folder-empty { margin: 8px; color: #666; font-size: 12px; }

    /* ── List View ── */
    .pv-list-view {
      display: flex; flex-direction: column; gap: 16px;
    }
    .pv-card {
      display: flex; gap: 16px; background: #1a1a1a;
      border-radius: 8px; overflow: hidden; border: 1px solid #333;
    }
    .pv-img-wrap {
      width: 280px; max-height: 350px; flex-shrink: 0;
      overflow: hidden; background: #111;
      display: flex; align-items: center; justify-content: center;
    }
    .pv-img {
      width: 100%; height: 100%; object-fit: contain;
      cursor: pointer;
    }
    .pv-img:hover { opacity: 0.85; }
    .pv-info { padding: 12px; flex: 1; overflow: hidden; }
    .pv-filename {
      font-size: 13px; color: #888; margin-bottom: 8px;
      font-family: monospace;
    }
    .pv-prompts { display: flex; flex-direction: column; gap: 8px; }
    .pv-prompt-card {
      background: #252525; border-radius: 6px; padding: 10px;
      border-left: 3px solid #5b7ff5;
    }
    .pv-prompt-header {
      display: flex; align-items: baseline; justify-content: space-between;
      gap: 8px; margin-bottom: 4px;
    }
    .pv-prompt-label {
      font-size: 11px; color: #7a9bff;
      font-family: monospace; text-transform: uppercase;
    }
    .pv-prompt-text {
      font-size: 13px; line-height: 1.5; color: #ccc;
      white-space: pre-wrap; word-break: break-word;
    }
    .pv-no-prompt {
      font-size: 13px; color: #666; font-style: italic;
    }

    /* ── Grid View ── */
    .pv-grid-view {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 12px;
    }
    .pv-tile {
      background: #1a1a1a; border-radius: 8px; overflow: hidden;
      border: 1px solid #333; cursor: pointer; transition: border-color 0.15s;
    }
    .pv-tile:hover { border-color: #5b7ff5; }
    .pv-tile-img {
      width: 100%; aspect-ratio: 1; object-fit: cover;
      display: block; background: #111;
    }
    .pv-tile-name {
      padding: 6px 8px; font-size: 11px; color: #888;
      font-family: monospace; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }

    /* ── Lightbox ── */
    #pv-lightbox {
      position: fixed; inset: 0; z-index: 200000;
    }
    #pv-lb-backdrop {
      width: 100%; height: 100%; background: rgba(0,0,0,0.9);
      display: flex; align-items: center; justify-content: center;
    }
    #pv-lb-img {
      max-width: 90vw; max-height: 90vh; object-fit: contain;
      border-radius: 4px;
    }
    #pv-lb-close {
      position: fixed; top: 20px; right: 20px;
      font-size: 28px; background: none; border: none; color: #eee;
      cursor: pointer; z-index: 200001;
    }
    .pv-nav-arrow {
      position: fixed; top: 50%; transform: translateY(-50%);
      z-index: 200001;
      background: rgba(0,0,0,0.5); border: none; color: #eee;
      font-size: 40px; cursor: pointer; padding: 12px 16px;
      border-radius: 6px; line-height: 1; user-select: none;
      transition: background 0.15s;
    }
    .pv-nav-arrow:hover { background: rgba(255,255,255,0.15); }
    .pv-nav-left { left: 16px; }
    .pv-nav-right { right: 16px; }
    #pv-lb-counter {
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      color: #aaa; font-size: 13px; font-family: monospace; z-index: 200001;
    }

    /* ── Detail Panel ── */
    #pv-detail {
      background: #1a1a1a; border-radius: 10px; max-width: 900px;
      max-height: 90vh; overflow: auto; display: flex; flex-direction: column;
      border: 1px solid #333; position: relative;
    }
    #pv-detail-img {
      width: 100%; max-height: 500px; object-fit: contain;
      background: #111; border-radius: 10px 10px 0 0;
    }
    #pv-detail-info {
      padding: 16px;
    }
  `;
  overlay.appendChild(style);
}

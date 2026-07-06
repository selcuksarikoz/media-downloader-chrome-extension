import { DEFAULT_BLACKLISTED_DOMAINS } from "./shared.js";

const DEFAULTS = {
  buttonPosition: "top-right",
  downloadFolder: "",
  showSaveAs: true,
  showPreviewButton: true,
  showVideoControls: true,
  captureType: "jpg",
  blacklistedDomains: [...DEFAULT_BLACKLISTED_DOMAINS],
  minWidth: 150,
  maxConcurrentDownloads: 5,
};
const get = (id) => document.getElementById(id);
let blacklistedDomains = [...DEFAULTS.blacklistedDomains];

function saveOptions() {
  const requestedFolder = get("folder").value.trim();
  const folder = hasForbiddenFolder(requestedFolder) ? "" : requestedFolder;

  chrome.storage.sync.set(
    {
      buttonPosition: get("position").value,
      downloadFolder: folder,
      showSaveAs: get("saveAs").checked,
      showPreviewButton: get("showPreview").checked,
      showVideoControls: get("showVideoControls").checked,
      captureType: get("captureType").value,
      blacklistedDomains,
      minWidth: parseInt(get("minWidth").value, 10) || DEFAULTS.minWidth,
      maxConcurrentDownloads: Math.min(
        10,
        Math.max(
          1,
          parseInt(get("maxConcurrent").value, 10) ||
            DEFAULTS.maxConcurrentDownloads
        )
      ),
    },
    () => {
      get("status").textContent = "Options saved.";
      setTimeout(() => (get("status").textContent = ""), 2000);
    }
  );
}

function restoreOptions() {
  chrome.storage.sync.get(DEFAULTS, (items) => {
    const folder = hasForbiddenFolder(items.downloadFolder)
      ? ""
      : items.downloadFolder;
    get("position").value = items.buttonPosition;
    get("folder").value = folder;
    get("saveAs").checked = items.showSaveAs;
    get("showPreview").checked = items.showPreviewButton;
    get("showVideoControls").checked = items.showVideoControls;
    get("captureType").value = ["jpg", "png", "webp"].includes(
      items.captureType
    )
      ? items.captureType
      : DEFAULTS.captureType;
    get("minWidth").value = items.minWidth;
    get("maxConcurrent").value = items.maxConcurrentDownloads;
    blacklistedDomains = normalizeDomainList(items.blacklistedDomains);
    renderBlacklist();
    if (folder !== items.downloadFolder) {
      chrome.storage.sync.set({ downloadFolder: "" });
    }
  });
}

function normalizeDomain(value) {
  if (typeof value !== "string") return null;
  const input = value.trim().toLowerCase().replace(/^\*\./, "");
  if (!input) return null;
  try {
    const hostname = new URL(
      input.includes("://") ? input : `https://${input}`
    ).hostname
      .replace(/^www\./, "")
      .replace(/\.$/, "");
    if (
      !/^[a-z0-9.-]+$/.test(hostname) ||
      hostname
        .split(".")
        .some(
          (part) => !part || part.startsWith("-") || part.endsWith("-")
        ) ||
      (!hostname.includes(".") && hostname !== "localhost")
    ) {
      return null;
    }
    return hostname;
  } catch {
    return null;
  }
}

function normalizeDomainList(domains) {
  if (!Array.isArray(domains)) return [...DEFAULTS.blacklistedDomains];
  return [...new Set(domains.map(normalizeDomain).filter(Boolean))];
}

function renderBlacklist() {
  const list = get("blacklist");
  list.replaceChildren();
  blacklistedDomains.forEach((domain) => {
    const row = document.createElement("div");
    row.className = "domain-item";
    const name = document.createElement("span");
    name.textContent = domain;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn-domain-delete";
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", `Remove ${domain} from blacklist`);
    remove.addEventListener("click", () => {
      blacklistedDomains = blacklistedDomains.filter((item) => item !== domain);
      renderBlacklist();
      persistBlacklist("Domain removed.");
    });
    row.append(name, remove);
    list.appendChild(row);
  });
  if (!blacklistedDomains.length) {
    const empty = document.createElement("div");
    empty.className = "domain-list-empty";
    empty.textContent = "No blacklisted domains.";
    list.appendChild(empty);
  }
}

function addBlacklistDomain() {
  const input = get("blacklistDomain");
  const domain = normalizeDomain(input.value);
  if (!domain) {
    get("status").textContent = "Enter a valid domain, such as example.com.";
    return;
  }
  if (blacklistedDomains.includes(domain)) {
    get("status").textContent = `"${domain}" is already blacklisted.`;
    return;
  }
  blacklistedDomains.push(domain);
  blacklistedDomains.sort();
  input.value = "";
  renderBlacklist();
  persistBlacklist("Domain added.");
}

function persistBlacklist(message) {
  chrome.storage.sync.set({ blacklistedDomains }, () => {
    get("status").textContent = message;
    setTimeout(() => {
      if (get("status").textContent === message) get("status").textContent = "";
    }, 2000);
  });
}

function hasForbiddenFolder(folder) {
  return folder
    .trim()
    .split(/[\/\\]+/)
    .some((part) => part.toLowerCase() === "imgdownloader_files");
}

document.addEventListener("DOMContentLoaded", restoreOptions);
get("save").addEventListener("click", saveOptions);
get("addBlacklistDomain").addEventListener("click", addBlacklistDomain);
get("blacklistDomain").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addBlacklistDomain();
});

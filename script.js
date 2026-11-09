const AUTH_URL = "https://libertylink-auth.gavunblake.workers.dev";
const toast = document.getElementById("auth-toast");
let toastTimer;

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 4500);
}

function setSignedIn(user) {
  document.querySelectorAll("[data-auth]").forEach((button) => {
    button.dataset.auth = "logout";
    button.textContent = button.classList.contains("button-ghost")
      ? "Log out"
      : "Account connected";
  });
  showToast("Signed in as " + (user.global_name || user.username) + "!");
}

function setSignedOut() {
  document.querySelectorAll("[data-auth]").forEach((button) => {
    const isSignup = button.dataset.originalAuth === "signup" ||
      button.textContent.toLowerCase().includes("get started") ||
      button.textContent.toLowerCase().includes("sign up") ||
      button.textContent.toLowerCase().includes("continue");
    button.dataset.auth = isSignup ? "signup" : "login";
  });
}

async function loadCurrentUser(token, showMessage = false) {
  try {
    const response = await fetch(AUTH_URL + "/me", {
      headers: { Authorization: "Bearer " + token }
    });
    if (!response.ok) throw new Error("Session expired");
    const user = await response.json();
    setSignedIn(user);
    return user;
  } catch (error) {
    sessionStorage.removeItem("ll_session");
    setSignedOut();
    if (showMessage) showToast("Your sign-in could not be verified. Please try again.");
    return null;
  }
}

document.querySelectorAll("[data-auth]").forEach((button) => {
  button.dataset.originalAuth = button.dataset.auth;
  button.addEventListener("click", () => {
    if (button.dataset.auth === "logout") {
      sessionStorage.removeItem("ll_session");
      setSignedOut();
      window.location.reload();
      return;
    }
    window.location.href = AUTH_URL + "/login";
  });
});

const menuButton = document.querySelector(".menu-toggle");
const nav = document.querySelector(".desktop-nav");
if (menuButton && nav) {
  menuButton.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("open");
    menuButton.setAttribute("aria-expanded", String(isOpen));
  });
  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      nav.classList.remove("open");
      menuButton.setAttribute("aria-expanded", "false");
    });
  });
}

const year = document.getElementById("year");
if (year) year.textContent = new Date().getFullYear();

const hash = new URLSearchParams(window.location.hash.slice(1));
const returnedSession = hash.get("session");
if (returnedSession) {
  sessionStorage.setItem("ll_session", returnedSession);
  history.replaceState(null, "", window.location.pathname + window.location.search);
  loadCurrentUser(returnedSession, true);
} else {
  const existingSession = sessionStorage.getItem("ll_session");
  if (existingSession) loadCurrentUser(existingSession);
}


// Liberty Link server directory
function getSession() {
  return sessionStorage.getItem("ll_session") || "";
}
async function api(path, options = {}) {
  const response = await fetch(AUTH_URL + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + getSession(),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}
function setMessage(id, message, isError = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", isError);
}
function showServerResult(server, joinUrl) {
  const panel = document.getElementById("created-server-panel");
  if (!panel) return;
  panel.hidden = false;
  panel.innerHTML = "";
  const title = document.createElement("h3");
  title.textContent = "Your server is ready!";
  const description = document.createElement("p");
  description.textContent = server.name + " is connected to Discord server " + server.discord_guild_name + ".";
  const codeLabel = document.createElement("label");
  codeLabel.textContent = "YOUR JOIN CODE";
  const code = document.createElement("div");
  code.className = "created-code";
  code.textContent = server.join_code;
  const linkLabel = document.createElement("label");
  linkLabel.textContent = "INVITATION LINK";
  const link = document.createElement("a");
  link.href = joinUrl;
  link.textContent = joinUrl;
  link.target = "_blank";
  link.rel = "noopener";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "button button-primary";
  copy.textContent = "Copy invitation link";
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(joinUrl);
    copy.textContent = "Copied!";
  });
  panel.append(title, description, codeLabel, code, linkLabel, link, copy);
  panel.scrollIntoView({ behavior: "smooth", block: "center" });
}
async function loadGuildChoices() {
  const select = document.getElementById("discord-guild");
  if (!select) return;
  select.innerHTML = '<option value="">Loading...</option>';
  try {
    const data = await api("/api/guilds");
    select.innerHTML = "";
    if (!data.guilds.length) {
      select.innerHTML = '<option value="">No manageable Discord servers found</option>';
      return;
    }
    select.add(new Option("Select a Discord server", ""));
    data.guilds.forEach(guild => select.add(new Option(guild.name, guild.id)));
  } catch (error) {
    select.innerHTML = '<option value="">Sign in to load Discord servers</option>';
    setMessage("create-server-message", error.message, true);
  }
}
async function loadServers() {
  const dashboard = document.getElementById("server-dashboard");
  const list = document.getElementById("server-list");
  if (!dashboard || !list || !getSession()) return;
  try {
    const data = await api("/api/servers");
    dashboard.hidden = false;
    list.innerHTML = "";
    if (!data.servers.length) {
      const empty = document.createElement("p");
      empty.className = "form-hint";
      empty.textContent = "You haven't joined any Liberty Link servers yet.";
      list.append(empty);
      return;
    }
    data.servers.forEach(server => {
      const card = document.createElement("article");
      card.className = "server-list-card";
      const name = document.createElement("strong");
      name.textContent = server.name;
      const discord = document.createElement("span");
      discord.textContent = "Discord: " + server.discord_guild_name;
      const role = document.createElement("span");
      role.textContent = server.role;
      const publicLink = document.createElement("a");
      publicLink.href = "?server=" + encodeURIComponent(server.id);
      publicLink.textContent = "View public page ↗";
      publicLink.className = "server-page-link";
      card.append(name, discord, role, publicLink);
      if (true) {
        const staffLink = document.createElement("a");
        staffLink.href = "?server=" + encodeURIComponent(server.id) + "&view=staff";
        staffLink.textContent = "Open staff page →";
        staffLink.className = "server-page-link";
        card.append(staffLink);
      }
      list.append(card);
    });
  } catch (error) {
    setMessage("join-message", error.message, true);
  }
}
const createButton = document.getElementById("show-create-server");
const createForm = document.getElementById("create-server-form");
if (createButton && createForm) {
  createButton.addEventListener("click", async () => {
    if (!getSession()) {
      showToast("Please sign in with Discord before creating a server.");
      window.location.href = AUTH_URL + "/login";
      return;
    }
    createForm.hidden = false;
    await loadGuildChoices();
    createForm.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}
document.getElementById("cancel-create-server")?.addEventListener("click", () => {
  createForm.hidden = true;
});
document.getElementById("create-server-form")?.addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  setMessage("create-server-message", "Creating your server...");
  try {
    const data = await api("/api/servers", {
      method: "POST",
      body: JSON.stringify({
        name: document.getElementById("server-name").value,
        discordGuildId: document.getElementById("discord-guild").value
      })
    });
    showServerResult(data.server, data.join_url);
    setMessage("create-server-message", "Server created successfully.");
    await loadServers();
  } catch (error) {
    setMessage("create-server-message", error.message, true);
  } finally {
    button.disabled = false;
  }
});
document.getElementById("join-server-form")?.addEventListener("submit", async event => {
  event.preventDefault();
  if (!getSession()) {
    showToast("Please sign in with Discord before joining a server.");
    window.location.href = AUTH_URL + "/login";
    return;
  }
  setMessage("join-message", "Checking invitation code...");
  try {
    const data = await api("/api/join", {
      method: "POST",
      body: JSON.stringify({ code: document.getElementById("join-code").value })
    });
    setMessage("join-message", "You joined " + data.server.name + "!");
    await loadServers();
  } catch (error) {
    setMessage("join-message", error.message, true);
  }
});
document.getElementById("refresh-servers")?.addEventListener("click", loadServers);
const joinFromLink = new URLSearchParams(window.location.search).get("join");
if (joinFromLink) {
  document.getElementById("join-code").value = joinFromLink.toUpperCase();
  document.getElementById("directory").scrollIntoView({ behavior: "smooth" });
}
if (getSession()) loadServers();


// Liberty Link public server profiles and staff dashboard
const pageParams = new URLSearchParams(window.location.search);
const pageServerId = pageParams.get("server");
const pageView = pageParams.get("view");
const serverPages = document.getElementById("server-pages");
if (pageServerId && serverPages) {
  document.querySelector("main")?.classList.add("server-page-mode");
  serverPages.hidden = false;
  document.querySelectorAll("main > section:not(#server-pages)").forEach(section => section.hidden = true);
  loadServerPage();
}
async function loadServerPage() {
  const title = document.getElementById("server-page-title");
  const status = document.getElementById("server-page-status");
  const description = document.getElementById("server-page-description");
  const staffCount = document.getElementById("server-page-staff-count");
  const announcement = document.getElementById("server-page-announcement");
  try {
    const data = await api("/api/public/" + encodeURIComponent(pageServerId));
    const server = data.server;
    title.textContent = server.name;
    status.textContent = server.status === "online" ? "ONLINE" : "OFFLINE";
    status.className = "server-status " + (server.status === "online" ? "is-online" : "is-offline");
    description.textContent = server.description || "This community hasn't added a description yet.";
    staffCount.textContent = String(server.staff_count ?? 0);
    if (memberCount) memberCount.textContent = String(server.discord_member_count ?? 0);
    announcement.textContent = server.announcement || "No current announcements.";
    document.title = server.name + " — Liberty Link";
    document.getElementById("server-public-link").href = "?server=" + encodeURIComponent(pageServerId);
    if (pageView === "staff") await loadStaffPage();
  } catch (error) {
    title.textContent = "Community not found";
    description.textContent = error.message;
  }
}
async function loadStaffPage() {
  const panel = document.getElementById("staff-management");
  panel.hidden = false;
  try {
    const data = await api("/api/staff/" + encodeURIComponent(pageServerId));
    const server = data.server;
    document.getElementById("staff-status").value = server.status;
    const roleSetting = document.getElementById("staff-role-setting");
    const roleSelect = document.getElementById("staff-role");
    if (data.is_owner) {
      roleSetting.hidden = false;
      roleSelect.innerHTML = '<option value="">No staff role selected</option>';
      data.roles.forEach(role => roleSelect.add(new Option(role.name, role.id)));
      roleSelect.value = server.staff_role_id || "";
    } else {
      roleSetting.hidden = true;
    }
    document.getElementById("staff-description").value = server.description || "";
    document.getElementById("staff-announcement").value = server.announcement || "";
    document.getElementById("staff-save-message").textContent = "Staff access verified.";
  } catch (error) {
    document.getElementById("staff-save-message").textContent = error.message;
    document.getElementById("staff-settings-form").hidden = true;
  }
}
document.getElementById("staff-settings-form")?.addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  const message = document.getElementById("staff-save-message");
  message.textContent = "Saving changes...";
  try {
    await api("/api/staff/" + encodeURIComponent(pageServerId), {
      method: "PATCH",
      body: JSON.stringify({
        status: document.getElementById("staff-status").value,
        staff_count: Number(document.getElementById("staff-count").value),
        description: document.getElementById("staff-description").value,
        announcement: document.getElementById("staff-announcement").value
      })
    });
    message.textContent = "Changes saved!";
    await loadServerPage();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
document.getElementById("open-staff-page")?.addEventListener("click", () => {
  if (!getSession()) {
    window.location.href = AUTH_URL + "/login";
    return;
  }
  window.location.href = "?server=" + encodeURIComponent(pageServerId) + "&view=staff";
});
document.getElementById("back-public-page")?.addEventListener("click", () => {
  window.location.href = "?server=" + encodeURIComponent(pageServerId);
});

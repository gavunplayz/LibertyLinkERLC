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

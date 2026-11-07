// Discord OAuth will be connected once the Discord application credentials
// and the authentication callback are configured.
const toast = document.getElementById("auth-toast");
let toastTimer;

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 4200);
}

document.querySelectorAll("[data-auth]").forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.auth === "signup" ? "Sign up" : "Log in";
    showToast(action + " with Discord will be available as soon as Discord authentication is connected.");
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
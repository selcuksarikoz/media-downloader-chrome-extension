import { toastEl, toastTimer, setToastEl, setToastTimer } from './state.js';

export function showToast(message) {
  let el = toastEl;
  let timer = toastTimer;
  if (!el) {
    el = document.createElement("div");
    el.className = "imd-toast";
    el.setAttribute("role", "alert");
    document.documentElement.appendChild(el);
    setToastEl(el);
  }
  el.textContent = message;
  el.classList.add("imd-toast-show");
  clearTimeout(timer);
  setToastTimer(
    setTimeout(() => {
      el.classList.remove("imd-toast-show");
    }, 4000),
  );
}

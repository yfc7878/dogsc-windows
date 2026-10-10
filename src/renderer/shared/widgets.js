/**
 * Shared interactive primitives used by every DogSC window.
 *
 * These reproduce the behaviour of the AppKit controls the macOS original
 * relies on: NSPopUpButton menus with check marks, sliders paired with an
 * editable value well, hover tooltips, transient notices and sheets.
 */

import { icon } from "./icons.js";
import { t } from "./i18n.js";

/* -------------------------------------------------------------------------
   Native control drag guard
   ------------------------------------------------------------------------- */

/**
 * Whether a native control (a range slider) is mid-gesture.
 *
 * Surfaces that rebuild themselves on every model change have to ask first:
 * replacing the element under the pointer cancels the browser's own drag, so
 * the control ends up adjustable by clicking only. The original keeps a draft
 * for exactly this reason — its inspector never tears the slider down while
 * the user is holding it.
 */
let activeDrags = 0;

export function isControlDragging() {
  return activeDrags > 0;
}

function setControlDragging(active) {
  activeDrags = Math.max(0, activeDrags + (active ? 1 : -1));
}

/* -------------------------------------------------------------------------
   Hover tooltip (matches the original's .help() strings)
   ------------------------------------------------------------------------- */

let tooltipEl = null;
let tooltipTimer = null;

function ensureTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement("div");
  tooltipEl.id = "dogsc-tooltip";
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}

export function attachTooltip(node, text) {
  if (!text) return;
  /* The element is captured in the closure: `event.currentTarget` is only
     valid while the event is being dispatched, and the tooltip is shown from
     a timer that fires afterwards. */
  const show = () => {
    clearTimeout(tooltipTimer);
    const el = ensureTooltip();
    el.textContent = typeof text === "function" ? text() : text;
    el.classList.add("is-visible");
    positionTooltip(el, node);
  };
  const hide = () => {
    clearTimeout(tooltipTimer);
    if (tooltipEl) tooltipEl.classList.remove("is-visible");
  };
  node.addEventListener("mouseenter", () => {
    tooltipTimer = setTimeout(show, 480);
  });
  node.addEventListener("mousemove", () => {
    if (tooltipEl && tooltipEl.classList.contains("is-visible")) positionTooltip(tooltipEl, node);
  });
  node.addEventListener("mouseleave", hide);
  node.addEventListener("mousedown", hide);
  node.addEventListener("click", hide);
}

function positionTooltip(el, target) {
  if (!target || typeof target.getBoundingClientRect !== "function") return;
  const rect = target.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - box.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
  let top = rect.bottom + 7;
  if (top + box.height > window.innerHeight - 8) top = rect.top - box.height - 7;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

/* -------------------------------------------------------------------------
   Toasts
   ------------------------------------------------------------------------- */

let toastHost = null;

export function toast(message, options = {}) {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.id = "dogsc-toasts";
    document.body.appendChild(toastHost);
  }
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `${icon(options.icon || "info", 15)}<span></span>`;
  el.querySelector("span").textContent = message;
  toastHost.appendChild(el);
  const life = options.duration ?? 2400;
  setTimeout(() => {
    el.style.transition = "opacity .2s ease, transform .2s ease";
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    setTimeout(() => el.remove(), 220);
  }, life);
  return el;
}

/* -------------------------------------------------------------------------
   Popover menus
   ------------------------------------------------------------------------- */

let openPopover = null;

let openPopoverClose = null;

export function closePopover() {
  if (openPopover) {
    openPopover.remove();
    openPopover = null;
    document.removeEventListener("mousedown", onDocMouseDown, true);
    document.removeEventListener("keydown", onDocKeyDown, true);
    /* Notify the host (e.g. the recorder bar shrinks its window back). */
    const done = openPopoverClose;
    openPopoverClose = null;
    done?.();
  }
}

function onDocMouseDown(event) {
  if (openPopover && !openPopover.contains(event.target)) closePopover();
}
function onDocKeyDown(event) {
  if (event.key === "Escape") {
    event.stopPropagation();
    closePopover();
  }
}

/**
 * @param {HTMLElement} anchor
 * @param {Array} items  { label, value, checked, icon, note, disabled, separator, header, onSelect }
 * @param {object} options { align: 'left'|'right'|'center', width }
 */
export function showMenu(anchor, items, options = {}) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "popover";
  if (options.width) pop.style.width = `${options.width}px`;

  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "menu-separator";
      pop.appendChild(sep);
      continue;
    }
    if (item.header) {
      const head = document.createElement("div");
      head.className = "menu-header";
      head.textContent = item.header;
      pop.appendChild(head);
      continue;
    }
    const row = document.createElement("div");
    row.className = "menu-item";
    if (item.checked) row.classList.add("is-selected");
    if (item.disabled) {
      row.style.opacity = "0.38";
      row.style.pointerEvents = "none";
    }
    const check = document.createElement("span");
    check.className = "menu-check";
    check.innerHTML = item.checked ? icon("check", 13) : "";
    row.appendChild(check);
    if (item.icon) {
      const ic = document.createElement("span");
      ic.innerHTML = icon(item.icon, 15);
      row.appendChild(ic.firstElementChild);
    }
    const label = document.createElement("span");
    label.textContent = item.label;
    row.appendChild(label);
    if (item.note) {
      const note = document.createElement("span");
      note.className = "menu-note";
      note.textContent = item.note;
      row.appendChild(note);
    }
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      closePopover();
      item.onSelect?.(item.value);
    });
    pop.appendChild(row);
  }

  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  const box = pop.getBoundingClientRect();
  let left;
  if (options.align === "right") left = rect.right - box.width;
  else if (options.align === "center") left = rect.left + rect.width / 2 - box.width / 2;
  else left = rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
  let top = rect.bottom + 6;
  if (top + box.height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - box.height - 6);
  }
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;

  openPopover = pop;
  openPopoverClose = options.onClose || null;
  setTimeout(() => {
    document.addEventListener("mousedown", onDocMouseDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);
  }, 0);
  return pop;
}

/* -------------------------------------------------------------------------
   Sheets
   ------------------------------------------------------------------------- */

export function showSheet({ title, message, confirmLabel, cancelLabel, danger, onConfirm }) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal";
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = message;
  modal.append(h, p);
  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const cancel = document.createElement("button");
  cancel.className = "btn";
  cancel.textContent = cancelLabel || t("取消");
  const confirm = document.createElement("button");
  confirm.className = "btn btn-primary";
  confirm.style.height = "var(--height-selection)";
  confirm.style.padding = "0 18px";
  if (danger) {
    confirm.style.background = "var(--recording)";
    confirm.style.color = "#fff";
  }
  confirm.textContent = confirmLabel || t("确定");
  actions.append(cancel, confirm);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  cancel.addEventListener("click", close);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  confirm.addEventListener("click", () => {
    close();
    onConfirm?.();
  });
  return { close, element: backdrop };
}

/* -------------------------------------------------------------------------
   Control factories
   ------------------------------------------------------------------------- */

export function segmented(items, value, onSelect, { className = "" } = {}) {
  const wrap = document.createElement("div");
  wrap.className = `segmented ${className}`;
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    if (item.icon) btn.innerHTML = icon(item.icon, 14);
    const label = document.createElement("span");
    label.textContent = item.label;
    btn.appendChild(label);
    if (item.value === value) btn.classList.add("is-selected");
    if (item.title) attachTooltip(btn, item.title);
    btn.addEventListener("click", () => onSelect(item.value));
    wrap.appendChild(btn);
  }
  return wrap;
}

export function choiceGroup(items, value, onSelect) {  const wrap = document.createElement("div");
  wrap.className = "choice-row";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "choice";
    if (item.value === value) btn.classList.add("is-selected");
    const label = document.createElement("span");
    label.textContent = item.label;
    btn.appendChild(label);
    if (item.value === value) {
      const tick = document.createElement("span");
      tick.className = "tick";
      tick.innerHTML = icon("check", 13);
      btn.appendChild(tick.firstElementChild);
    }
    btn.addEventListener("click", () => onSelect(item.value));
    wrap.appendChild(btn);
  }
  return wrap;
}

/**
 * Slider paired with an editable numeric well — the original's signature
 * inspector control. `format` renders the chip text, `parse` accepts edits.
 */
export function sliderRow({
  label,
  value,
  min = 0,
  max = 1,
  step = 0.01,
  format = (v) => String(Math.round(v * 100)),
  suffix = "",
  parse = (text) => Number(text),
  scale = 1,
  onChange,
  onCommit,
  tooltip,
}) {
  const row = document.createElement("div");
  row.className = "slider-row";

  const lab = document.createElement("span");
  lab.className = "field-label";
  lab.textContent = label;
  row.appendChild(lab);

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  row.appendChild(input);

  const well = document.createElement("label");
  well.className = "value-well";
  const field = document.createElement("input");
  field.type = "text";
  field.value = format(value);
  well.appendChild(field);
  if (suffix) {
    const s = document.createElement("span");
    s.className = "suffix";
    s.textContent = suffix;
    well.appendChild(s);
  }
  row.appendChild(well);

  let current = value;
  const paint = (v) => {
    current = v;
    input.value = String(v);
    field.value = format(v);
  };

  /* A native range input captures the pointer for the whole gesture, so its own
     events are enough to bracket the drag — no window listeners to leak when
     the row is rebuilt. */
  let dragging = false;
  const startDrag = () => {
    if (dragging) return;
    dragging = true;
    setControlDragging(true);
  };
  const stopDrag = () => {
    if (!dragging) return;
    dragging = false;
    setControlDragging(false);
  };
  input.addEventListener("pointerdown", startDrag);
  input.addEventListener("pointerup", stopDrag);
  input.addEventListener("pointercancel", stopDrag);

  input.addEventListener("input", () => {
    const v = Number(input.value);
    paint(v);
    onChange?.(v);
  });
  input.addEventListener("change", () => {
    stopDrag();
    onCommit?.(Number(input.value));
  });

  field.addEventListener("focus", () => field.select());
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      field.blur();
      e.stopPropagation();
    } else if (e.key === "Escape") {
      paint(current);
      field.blur();
      e.stopPropagation();
    }
  });
  field.addEventListener("blur", () => {
    const raw = parse(field.value.replace(suffix, "").trim());
    if (!Number.isFinite(raw)) {
      paint(current);
      return;
    }
    const clamped = Math.min(max, Math.max(min, raw * scale));
    paint(clamped);
    onCommit?.(clamped);
  });

  row.setValue = paint;
  if (tooltip) attachTooltip(row, tooltip);
  return row;
}

export function switchRow(label, value, onChange, { tooltip } = {}) {
  const row = document.createElement("div");
  row.className = "switch-row";
  const lab = document.createElement("span");
  lab.className = "field-label";
  lab.textContent = label;
  row.appendChild(lab);
  const sw = document.createElement("button");
  sw.type = "button";
  sw.className = "switch";
  if (value) sw.classList.add("is-on");
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-checked", String(!!value));
  sw.addEventListener("click", () => {
    const next = !sw.classList.contains("is-on");
    sw.classList.toggle("is-on", next);
    sw.setAttribute("aria-checked", String(next));
    onChange(next);
  });
  row.appendChild(sw);
  row.setValue = (v) => {
    sw.classList.toggle("is-on", !!v);
    sw.setAttribute("aria-checked", String(!!v));
  };
  if (tooltip) attachTooltip(row, tooltip);
  return row;
}

export function iconButton(name, { size = 17, title, className = "btn btn-icon", onClick } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.innerHTML = icon(name, size);
  if (title) {
    attachTooltip(btn, title);
    btn.setAttribute("aria-label", title);
  }
  if (onClick) btn.addEventListener("click", onClick);
  return btn;
}

export function textField({ value = "", placeholder = "", onInput, onCommit } = {}) {
  const input = document.createElement("input");
  input.className = "text-field";
  input.type = "text";
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  input.addEventListener("input", () => onInput?.(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    e.stopPropagation();
  });
  input.addEventListener("blur", () => onCommit?.(input.value));
  return input;
}

/* -------------------------------------------------------------------------
   Formatting helpers shared with the original's time formatting
   ------------------------------------------------------------------------- */

export function formatTimecode(seconds, { frames = 0, fps = 30 } = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  if (frames) {
    const ff = String(Math.floor((seconds - total) * fps)).padStart(2, "0");
    return `${mm}:${ss}.${ff}`;
  }
  const cs = String(Math.floor((seconds - total) * 100)).padStart(2, "0");
  return `${mm}:${ss}.${cs}`;
}

export function formatRulerTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  const cs = String(Math.floor((seconds - total) * 100)).padStart(2, "0");
  return `${mm}:${ss}.${cs}`;
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

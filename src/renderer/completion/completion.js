/**
 * Recording completion sheet.
 *
 * Shown once a recording has been written to a project package. Offers the
 * same three routes as the original: open the editor, keep the project for
 * later, or send it to the Recycle Bin.
 */

import { icon } from "../shared/icons.js";
import { setLocale, t } from "../shared/i18n.js";
import { enableManualDrag, showSheet, toast, formatDuration, formatBytes } from "../shared/widgets.js";

const api = window.dogsc;

/* The completion sheet is frameless; its title bar moves the window
   programmatically because CSS app-region drag strobes on Windows here. */
enableManualDrag();
let payload = null;

async function boot() {
  setLocale("zh-Hans");
  const theme = await api.app.theme();
  document.documentElement.dataset.theme = theme.dark ? "dark" : "light";

  document.getElementById("btn-close").innerHTML = icon("close", 15);
  document.getElementById("btn-close").addEventListener("click", () => window.close());
  document.getElementById("btn-edit").addEventListener("click", () => openEditor());
  document.getElementById("btn-save").addEventListener("click", () => {
    toast(t("已保存"), { icon: "save" });
    window.close();
  });
  document.getElementById("btn-discard").addEventListener("click", () => discard());
  document.getElementById("btn-reveal-movie").addEventListener("click", () => {
    if (payload?.moviePath) api.exporter.reveal(payload.moviePath);
  });

  api.on("completion:init", (data) => {
    payload = data;
    render();
  });

  /* Pulled rather than pushed: `ready-to-show` can fire before the listener
     above is registered. */
  const initial = await api.windows.completionPayload();
  if (initial) {
    payload = initial;
    render();
  }
}

function render() {
  if (!payload) return;
  const poster = document.getElementById("poster");
  const empty = document.getElementById("preview-empty");
  if (payload.posterUrl) {
    poster.src = payload.posterUrl;
    poster.hidden = false;
    empty.hidden = true;
  } else {
    poster.hidden = true;
    empty.hidden = false;
  }
  document.getElementById("preview-meta").textContent = formatDuration(payload.duration || 0);

  /* "视频成片": the MP4 was already delivered while the project package was
     being assembled — surface where it landed and keep the project actions. */
  const note = document.getElementById("movie-note");
  if (payload.moviePath) {
    document.getElementById("movie-path").textContent = payload.moviePath;
    note.hidden = false;
    document.getElementById("sheet-hint").textContent = t(
      "成片已保存为 MP4；项目包同时保留，可随时回来继续编辑，或将这次录制移到回收站。"
    );
  } else {
    note.hidden = true;
  }

  /* A take interrupted by a crash or a forced quit, rebuilt on this launch.
     Same three routes, different wording so the user knows what happened. */
  if (payload.recovered) {
    document.querySelector(".sheet-title").textContent = t("已恢复中断的录制");
    document.getElementById("sheet-hint").textContent = t(
      "上次录制意外中断，已保留可用部分。可以继续编辑，或将这次录制移到回收站。"
    );
  }
}

function openEditor() {
  if (!payload) return;
  api.windows.openEditor({ projectPath: payload.packagePath });
  window.close();
}

function discard() {
  if (!payload) return;
  showSheet({
    title: t("删除这个项目？"),
    message: t("项目和其中的录制素材将移到废纸篓，需要时可从废纸篓恢复。"),
    confirmLabel: t("移到废纸篓"),
    danger: true,
    onConfirm: async () => {
      /* A failure is reported instead of thrown: the sheet is already closed
         at this point, so an unhandled rejection would leave the user with a
         window that simply does nothing. */
      const result = await api.project.discard(payload.packagePath).catch((error) => ({
        ok: false,
        reason: "failed",
        message: String(error?.message || error),
      }));
      if (result?.ok) {
        window.close();
        return;
      }
      const reasons = {
        "invalid-path": t("项目路径无效，无法移到废纸篓。"),
        missing: t("项目已经不在原来的位置了。"),
        "trash-failed": t("无法移到废纸篓：%@", result?.message || ""),
      };
      toast(reasons[result?.reason] || t("无法移到废纸篓：%@", result?.message || ""), {
        icon: "info",
        duration: 5000,
      });
    },
  });
}

boot();

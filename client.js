/*!
 * dsh-paper-reader — client half (browser bundle).
 *
 * Registers one "Paper reader" tab with dsh-better-sidebar. The tab renders
 * the uploaded PDF with pdf.js: every page is a canvas at device-pixel
 * resolution (original layout, fonts and figures intact) plus the original
 * text layer for selection. A selection opens a floating menu with highlight,
 * note and ask-in-conversation; the question prompt follows the UI language.
 *
 * Bundle format: the DSH client-bundle shape — a lazy-CJS closure registered
 * with window.__ModuleLoader__.load({ id, factory }). `react` / `react-dom`
 * resolve from the shell's module table; pdf.js is vendored under
 * /paper-reader/static and loaded on first use.
 */
window.__ModuleLoader__.load({
  id: "dsh-paper-reader",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";

    var React = require("react");
    var ReactDOM = require("react-dom");
    /* Shared settings chrome: the same controls every DSH settings page uses. */
    var primitives = null;
    try { primitives = require("@deepseek-ai/dsh-client-ui-primitives"); } catch (error) { primitives = null; }

    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useCallback = React.useCallback;

    // ── constants ────────────────────────────────────────────────────────────

    var STATIC_BASE = "/paper-reader/static/";
    var API_BASE = "/paper-reader/api/";
    var LAST_DOC_KEY = "dsh-paper-reader:last-doc";
    var HIGHLIGHT_COLOR = "#ffd54f";
    var NOTE_COLOR = "#7fd18a";
    var MAX_PROMPT_QUOTE = 4000;

    // ── icons ────────────────────────────────────────────────────────────────

    var ICONS = {
      book: [
        ["path", { d: "M3 3.4c2.2-.8 3.9-.7 5 0v9.2c-1.1-.7-2.8-.8-5 0V3.4Z" }],
        ["path", { d: "M13 3.4c-2.2-.8-3.9-.7-5 0v9.2c1.1-.7 2.8-.8 5 0V3.4Z" }]
      ],
      chevronDown: [["path", { d: "m4.5 6.5 3.5 3.5 3.5-3.5" }]],
      chevronLeft: [["path", { d: "M9.5 4.5 6 8l3.5 3.5" }]],
      chevronRight: [["path", { d: "M6.5 4.5 10 8l-3.5 3.5" }]],
      plus: [["path", { d: "M8 3.5v9M3.5 8h9" }]],
      minus: [["path", { d: "M3.5 8h9" }]],
      more: [
        ["circle", { cx: 3.4, cy: 8, r: 1.1, fill: "currentColor", stroke: "none" }],
        ["circle", { cx: 8, cy: 8, r: 1.1, fill: "currentColor", stroke: "none" }],
        ["circle", { cx: 12.6, cy: 8, r: 1.1, fill: "currentColor", stroke: "none" }]
      ],
      bookmark: [["path", { d: "M4 2.6h8v11l-4-2.6-4 2.6z" }]],
      trash: [["path", { d: "M3 4h10M6.2 4V2.8h3.6V4M4.6 4l.6 8.6h5.6L11.4 4" }]],
      upload: [["path", { d: "M8 10.4V3.4M5 6.4l3-3 3 3M3 12.6h10" }]],
      download: [["path", { d: "M8 2.8v7M5 6.8l3 3 3-3M3 13.2h10" }]],
      close: [["path", { d: "m4.4 4.4 7.2 7.2M11.6 4.4l-7.2 7.2" }]],
      pencil: [["path", { d: "M10.6 2.8 13.2 5.4 5.5 13.1H2.9V10.5z" }], ["path", { d: "m9.4 4 2.6 2.6" }]],
      chat: [["path", { d: "M2.8 3.4h10.4v6.8H8.1L4.8 12.9v-2.7H2.8z" }]],
      marker: [
        ["path", { d: "M4.2 9.4 9.7 3.9l2.4 2.4-5.5 5.5H4.2z" }],
        ["path", { d: "M9.2 2.9 10.6 1.5M2.9 13.1h10.2" }]
      ],
      file: [["path", { d: "M4 2.5h5l3 3v8H4z" }], ["path", { d: "M9 2.5v3h3" }]],
      check: [["path", { d: "m3.6 8.4 2.8 2.8 6-6.8" }]],
      expand: [["path", { d: "M6 3H3v3M10 13h3v-3M3 10v3h3M13 6V3h-3" }]],
      info: [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M8 7.3v4M8 4.9v.2" }]],
      gear: [
        ["circle", { cx: 8, cy: 8, r: 2.2 }],
        ["path", { d: "M8 1.8v1.5M8 12.7v1.5M1.8 8h1.5M12.7 8h1.5M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" }]
      ],
      folder: [
        ["path", { d: "M2 4.4h4.2l1.2 1.5H14v5.9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.4z" }]
      ],
      code: [
        ["path", { d: "M6 4.5 2.5 8 6 11.5M10 4.5 13.5 8 10 11.5" }]
      ],
      link: [
        ["path", { d: "M6.6 9.4 9.4 6.6" }],
        ["path", { d: "M7.2 4.6 8.5 3.3a2.4 2.4 0 0 1 3.4 3.4l-1.3 1.3" }],
        ["path", { d: "M8.8 11.4 7.5 12.7a2.4 2.4 0 0 1-3.4-3.4l1.3-1.3" }]
      ],
      arrowUp: [
        ["path", { d: "M8 12.6V3.4M4.6 6.8 8 3.4l3.4 3.4" }]
      ],
      search: [["circle", { cx: 7.2, cy: 7.2, r: 4.2 }], ["path", { d: "m10.4 10.4 2.6 2.6" }]],
      at: [
        ["circle", { cx: 7.6, cy: 8, r: 2.1 }],
        ["path", { d: "M9.7 8v1.1a1.7 1.7 0 0 0 3.4 0V7.9a5.6 5.6 0 1 0-2.2 4.4" }]
      ]
    };

    function Icon(props) {
      var name = props.name;
      var size = props.size === undefined ? 16 : props.size;
      var paths = ICONS[name] === undefined ? [] : ICONS[name];
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.4,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false"
        },
        paths.map(function (entry, index) {
          var tag = entry[0];
          var attrs = Object.assign({ key: index }, entry[1]);
          return h(tag, attrs);
        })
      );
    }

    // ── strings ──────────────────────────────────────────────────────────────

    var STRINGS = {
      zh: {
        tabTitle: "论文阅读器",
        tabDesc: "原样阅读 PDF 论文，支持高亮、笔记与就选段向会话提问",
        library: "论文库",
        upload: "上传论文",
        uploadShort: "导入 PDF",
        emptyTitle: "把论文拖进来",
        emptyDesc: "PDF 按原始排版、字体与插图逐页渲染，导入后不改变任何内容",
        chooseFile: "选择 PDF 文件",
        dropHere: "松开以导入 PDF",
        opening: "正在打开论文…",
        uploading: "正在导入…",
        openFailed: "论文打开失败",
        errorHint: "文件可能已损坏或被截断（例如缺少 xref / EOF）。阅读器不会改动原件，可下载后用其它工具修复。",
        downloadOriginal: "下载原件",
        retry: "重试",
        fitWidth: "适合宽度",
        zoomIn: "放大",
        zoomOut: "缩小",
        pageOf: function (a, b) { return "第 " + a + " / " + b + " 页"; },
        prevPage: "上一页",
        nextPage: "下一页",
        highlight: "高亮",
        addNote: "笔记",
        ask: "提问",
        noteTitle: "添加笔记",
        editNoteTitle: "编辑笔记",
        notePlaceholder: "写下对这段内容的理解、疑问或联想…",
        quote: "选段",
        save: "保存",
        cancel: "取消",
        delete: "删除",
        confirmDelete: "确认删除",
        annotations: "标注",
        noAnnotations: "还没有高亮或笔记。选中正文任意文字即可添加。",
        highlightKind: "高亮",
        noteKind: "笔记",
        askQueued: "已把问题放进输入框，按回车发送",
        askFailed: "没能写入输入框，请先在会话里点一下",
        notPdf: "请选择 PDF 文件",
        deletePaper: "删除这篇论文",
        downloadPdf: "下载 PDF 原件",
        untitled: "未命名论文",
        pages: function (n) { return n + " 页"; },
        emptyLibrary: "论文库还是空的，导入第一篇 PDF 吧。",
        imported: "已导入",
        deleted: "已删除",
        saveFailed: "保存失败",
        annotate: "选中文字添加高亮或笔记",
        promptHeading: "请结合论文上下文解释下面这段内容，并说明它在论文中的作用：",
        promptFrom: "—— 摘自《{title}》第 {page} 页",
        noteQuoteLabel: "笔记",
        close: "关闭",
        zoomLevel: "缩放",
        more: "更多",
        page: "第 {n} 页",
        settings: "设置",
        settingsTitle: "阅读器设置",
        mineruSection: "MinerU 解析",
        mineruHint: "填入 MinerU 的 API Token 后，可在「更多」里把论文解析成 Markdown 与图片，供 agent 直接引用。Token 只保存在本机。",
        mineruKey: "API Token",
        mineruKeySet: "已保存（••••{hint}）",
        mineruModel: "解析模型",
        mineruModelHint: "vlm / pipeline / MinerU-HTML。",
        mineruLang: "文档语言",
        mineruLangHint: "ch / en / japan / korean。",
        saving: "保存中…",
        settingsUnavailable: "设置服务不可用。",
        settingsReadOnly: "当前部署的设置为只读。",
        parseRun: "解析正文（MinerU）",
        parseRunning: "正在解析…",
        parseDone: "解析完成",
        parseFailed: "解析失败",
        parseNoKey: "还没填 MinerU Token，先到插件页填。",
        parseSwitched: "已停掉当前解析，改用 MinerU",
        parseMineruDone: "已解析（MinerU）",
        atHintText: "使用 @ 向会话注入上下文",
        parseProgress: function (engine, percent) { return (engine === "mineru" ? "MinerU 解析中" : "本地解析中（markitdown）") + " · " + percent + "%"; },
        parseIdle: "未解析",
        atPath: "把论文目录写进输入框",
        pathBusy: "正在解析，稍后再插入论文目录",
        pathFailed: "读取论文目录失败",
        settingsFailed: "打不开设置页",
        codeTab: "代码",
        notesTab: "标注",
        codeSection: "关联代码",
        codeRepo: "开源仓库地址",
        codePath: "本地代码目录",
        codeEmpty: "这篇论文还没有关联代码。开源就填仓库地址，闭源可以留空让 AI 自己写。",
        codeSave: "保存关联",
        codeWrite: "让 AI 写实现",
        aiRepo: "AI 查找仓库",
        codeAskFile: "就这个文件提问",
        codeUp: "上一级",
        codeOpenRepo: "在浏览器打开仓库",
        aiAuthor: "AI",
        humanAuthor: "我",
        goSession: "回到会话",
        noSession: "未关联会话",
        saved: "已保存",
        copyLink: "复制定位链接",
        workRootLabel: "工作目录",
        workRootHint: "每篇论文在下面各占一个文件夹：pdf/ 放原文，markdown/ 放解析结果，code/ 放代码。默认 ~/.paper_reading。",
        parseDefaultHint: "上传后默认用 markitdown 静默转 Markdown；在阅读器里点「解析正文（MinerU）」会打断当前解析并改用 MinerU。",
        linkCopied: "已复制 paper:// 链接"
      },
      en: {
        tabTitle: "Paper Reader",
        tabDesc: "Read PDF papers in their original layout, with highlights, notes and ask-in-conversation",
        library: "Papers",
        upload: "Upload paper",
        uploadShort: "Import PDF",
        emptyTitle: "Drop a paper here",
        emptyDesc: "Pages render with their original layout, fonts and figures — the file itself is never altered",
        chooseFile: "Choose a PDF",
        dropHere: "Drop to import PDF",
        opening: "Opening paper…",
        uploading: "Importing…",
        openFailed: "Could not open the paper",
        errorHint: "The file may be damaged or truncated (for example missing xref / EOF). The reader never modifies the original; download it and repair it with another tool.",
        downloadOriginal: "Download original",
        retry: "Retry",
        fitWidth: "Fit width",
        zoomIn: "Zoom in",
        zoomOut: "Zoom out",
        pageOf: function (a, b) { return "Page " + a + " / " + b; },
        prevPage: "Previous page",
        nextPage: "Next page",
        highlight: "Highlight",
        addNote: "Note",
        ask: "Ask",
        noteTitle: "Add a note",
        editNoteTitle: "Edit note",
        notePlaceholder: "Write down what this passage makes you think…",
        quote: "Selection",
        save: "Save",
        cancel: "Cancel",
        delete: "Delete",
        confirmDelete: "Confirm",
        annotations: "Annotations",
        noAnnotations: "No highlights or notes yet. Select any text to add one.",
        highlightKind: "Highlight",
        noteKind: "Note",
        askQueued: "Question added to the composer — press Enter to send",
        askFailed: "Could not write to the composer. Click inside the conversation first.",
        notPdf: "Please choose a PDF file",
        deletePaper: "Delete this paper",
        downloadPdf: "Download original PDF",
        untitled: "Untitled paper",
        pages: function (n) { return n + (n === 1 ? " page" : " pages"); },
        emptyLibrary: "The library is empty. Import your first PDF.",
        imported: "Imported",
        deleted: "Deleted",
        saveFailed: "Save failed",
        annotate: "Select text to highlight or annotate",
        promptHeading: "Please explain the following passage in the context of the paper and its role in the paper:",
        promptFrom: "— From \"{title}\", page {page}",
        noteQuoteLabel: "Note",
        close: "Close",
        zoomLevel: "Zoom",
        more: "More",
        page: "Page {n}",
        settings: "Settings",
        settingsTitle: "Reader settings",
        mineruSection: "MinerU parsing",
        mineruHint: "With a MinerU API token the paper can be parsed into Markdown plus images from the More menu, so the agent can cite it directly. The token stays on this machine.",
        mineruKey: "API token",
        mineruKeySet: "Saved (••••{hint})",
        mineruModel: "Parser model",
        mineruModelHint: "vlm / pipeline / MinerU-HTML.",
        mineruLang: "Document language",
        mineruLangHint: "ch / en / japan / korean.",
        saving: "Saving…",
        settingsUnavailable: "Settings are not served right now.",
        settingsReadOnly: "This deployment stores settings read-only.",
        parseRun: "Parse text (MinerU)",
        parseRunning: "Parsing…",
        parseDone: "Parse finished",
        parseFailed: "Parse failed",
        parseNoKey: "No MinerU token yet — add one on the plugin page.",
        parseSwitched: "Stopped the current parse and switched to MinerU",
        parseMineruDone: "Parsed (MinerU)",
        atHintText: "Use @ to put this context into the conversation",
        parseProgress: function (engine, percent) { return (engine === "mineru" ? "MinerU parsing" : "Local parse (markitdown)") + " · " + percent + "%"; },
        parseIdle: "Not parsed",
        atPath: "Insert the paper folder into the composer",
        pathBusy: "Parsing — insert the folder afterwards",
        pathFailed: "Could not read the paper folder",
        settingsFailed: "Could not open the settings page",
        codeTab: "Code",
        notesTab: "Annotations",
        codeSection: "Linked code",
        codeRepo: "Open-source repository",
        codePath: "Local code directory",
        codeEmpty: "No code linked yet. Point at the open-source repo, or leave it empty and let the agent write an implementation.",
        codeSave: "Save link",
        codeWrite: "Ask the agent to implement",
        aiRepo: "Find repo with AI",
        codeAskFile: "Ask about this file",
        codeUp: "Parent folder",
        codeOpenRepo: "Open repository",
        aiAuthor: "AI",
        humanAuthor: "Me",
        goSession: "Back to conversation",
        noSession: "No linked conversation",
        saved: "Saved",
        copyLink: "Copy location link",
        workRootLabel: "Working folder",
        workRootHint: "Each paper gets one folder under this root: pdf/ keeps the original, markdown/ the extraction, code/ the code. Defaults to ~/.paper_reading.",
        parseDefaultHint: "Uploads convert silently with markitdown; choosing Parse text (MinerU) interrupts the current parse and switches engine.",
        linkCopied: "paper:// link copied"
      }
    };

    function langOf(ctx) {
      try {
        var active = ctx.locale.getLocale().active;
        if (typeof active === "string" && active !== "") {
          return active.toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
        }
      } catch (error) {
        /* locale service unavailable — fall through to the document language */
      }
      var tag = (document.documentElement.lang || "").toLowerCase();
      return tag.indexOf("zh") === 0 ? "zh" : "en";
    }

    function textOf(lang, key) {
      var table = STRINGS[lang] === undefined ? STRINGS.en : STRINGS[lang];
      var value = table[key];
      return value === undefined ? key : value;
    }

    function formatString(template, values) {
      return String(template).replace(/\{(\w+)\}/g, function (_, name) {
        return values[name] === undefined ? "" : String(values[name]);
      });
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
      if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
      return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    function formatDate(timestamp, lang) {
      try {
        return new Date(timestamp).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US", {
          month: "short",
          day: "numeric"
        });
      } catch (error) {
        return "";
      }
    }

    // ── pdf.js loader ────────────────────────────────────────────────────────

    var pdfLibPromise = null;

    function loadPdfLib() {
      if (window.pdfjsLib !== undefined) return Promise.resolve(window.pdfjsLib);
      if (pdfLibPromise !== null) return pdfLibPromise;
      pdfLibPromise = new Promise(function (resolve, reject) {
        var settled = false;
        var timer = null;
        function stopTimer() {
          if (timer !== null) {
            window.clearInterval(timer);
            timer = null;
          }
        }
        function succeed() {
          if (settled) return;
          settled = true;
          stopTimer();
          try {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = STATIC_BASE + "pdf.worker.min.js";
          } catch (error) {
            /* older builds set the worker themselves */
          }
          resolve(window.pdfjsLib);
        }
        function fail(message) {
          if (settled) return;
          settled = true;
          stopTimer();
          pdfLibPromise = null;
          reject(new Error(message));
        }
        var script = document.createElement("script");
        script.src = STATIC_BASE + "pdf.min.js";
        script.async = true;
        script.onload = function () {
          if (window.pdfjsLib === undefined) fail("pdf.js loaded but pdfjsLib is missing");
          else succeed();
        };
        script.onerror = function () {
          fail("pdf.js failed to load");
        };
        document.head.appendChild(script);
        /* The load event can be lost when the tab was throttled while the
           request was in flight, so poll the global as the source of truth. */
        var attempts = 0;
        timer = window.setInterval(function () {
          attempts += 1;
          if (window.pdfjsLib !== undefined) succeed();
          else if (attempts >= 150) fail("pdf.js failed to load");
        }, 100);
      });
      return pdfLibPromise;
    }

    // ── API ──────────────────────────────────────────────────────────────────

    function apiError(status, message) {
      var error = new Error(message);
      error.status = status;
      return error;
    }

    function readJson(response) {
      return response.text().then(function (text) {
        if (text === "") return null;
        try {
          return JSON.parse(text);
        } catch (error) {
          return null;
        }
      });
    }

    function getJson(url) {
      return fetch(url, { headers: { accept: "application/json" } }).then(function (response) {
        return readJson(response).then(function (body) {
          if (!response.ok) {
            var message = body && body.error && body.error.message ? body.error.message : "HTTP " + response.status;
            throw apiError(response.status, message);
          }
          return body;
        });
      });
    }

    function sendJsonRequest(url, method, payload) {
      return fetch(url, {
        method: method,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload === undefined ? {} : payload)
      }).then(function (response) {
        return readJson(response).then(function (body) {
          if (!response.ok) {
            var message = body && body.error && body.error.message ? body.error.message : "HTTP " + response.status;
            throw apiError(response.status, message);
          }
          return body;
        });
      });
    }

    function getSettings() {
      return getJson(API_BASE + "settings").then(function (body) { return body.settings; });
    }

    function patchSettings(patch) {
      return sendJsonRequest(API_BASE + "settings", "PATCH", patch).then(function (body) { return body.settings; });
    }

    function startParse(id, engine) {
      var query = "parse?id=" + encodeURIComponent(id) + "&engine=" + encodeURIComponent(engine === "mineru" ? "mineru" : "markdown");
      return sendJsonRequest(API_BASE + query, "POST", {}).then(function (body) { return body.parse; });
    }

    function readParse(id) {
      return getJson(API_BASE + "parse?id=" + encodeURIComponent(id)).then(function (body) { return body.parse; });
    }

    function readPaperFolder(id) {
      return getJson(API_BASE + "paperdir?id=" + encodeURIComponent(id)).then(function (body) { return body.folder; });
    }

    function readTree(path) {
      return getJson(API_BASE + "tree?path=" + encodeURIComponent(path)).then(function (body) { return body.listing; });
    }

    function patchDoc(docId, patch) {
      return sendJsonRequest(API_BASE + "doc?id=" + encodeURIComponent(docId), "PATCH", patch);
    }

    function deleteDoc(docId) {
      return fetch(API_BASE + "doc?id=" + encodeURIComponent(docId), { method: "DELETE" }).then(function (response) {
        if (!response.ok) throw apiError(response.status, "HTTP " + response.status);
        return true;
      });
    }

    function uploadFile(file) {
      return fetch(API_BASE + "upload?name=" + encodeURIComponent(file.name || "paper.pdf"), {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: file
      }).then(function (response) {
        return readJson(response).then(function (body) {
          if (!response.ok) {
            var message = body && body.error && body.error.message ? body.error.message : "HTTP " + response.status;
            throw apiError(response.status, message);
          }
          return body.doc;
        });
      });
    }

    // ── composer insertion ───────────────────────────────────────────────────

    function leadFor(draft) {
      if (draft.trim() === "") return "";
      return /\s$/.test(draft) ? "" : " ";
    }

    function foldClipboardOffset(draft, occurrences, offset) {
      var target = Math.max(0, Math.min(offset, draft.length));
      var shrink = 0;
      for (var i = 0; i < occurrences.length; i += 1) {
        var occurrence = occurrences[i];
        var end = occurrence.offset + occurrence.length;
        if (target >= end) {
          shrink += occurrence.length - 1;
          continue;
        }
        if (target > occurrence.offset) {
          return occurrence.offset - shrink + 1;
        }
        break;
      }
      return target - shrink;
    }

    function appendOffset(snapshot) {
      var draft = snapshot.draft;
      var occurrences = snapshot.occurrences === undefined ? [] : snapshot.occurrences;
      var token = snapshot.phase === "claimed" && snapshot.claim !== undefined && draft.indexOf(snapshot.claim.token) === 0
        ? snapshot.claim.token
        : "";
      if (token === "") return foldClipboardOffset(draft, occurrences, draft.length);
      var rest = draft.slice(token.length);
      var offsetInRest = occurrences
        .filter(function (occurrence) { return occurrence.offset >= token.length; })
        .map(function (occurrence) { return { offset: occurrence.offset - token.length, length: occurrence.length }; });
      return 1 + foldClipboardOffset(rest, offsetInRest, rest.length);
    }

    /**
     * Append `text` to one session's composer draft. Plain drafts take the
     * `setDraft` path; a draft that already carries an @-reference chip or a
     * `/command` chip goes through the host's span channel so those chips are
     * preserved instead of flattened.
     */
    function appendToComposer(ctx, sessionId, text) {
      try {
        var actx = ctx.sessions.scope(sessionId);
        if (actx === undefined) return false;
        var conversation = ctx.get("conversation");
        if (conversation === undefined || conversation.input === undefined) return false;
        var input = conversation.input.for(actx);
        var snapshot = input.state.getSnapshot();
        var draft = typeof snapshot.draft === "string" ? snapshot.draft : "";
        var occurrences = snapshot.occurrences === undefined ? [] : snapshot.occurrences;
        if (occurrences.length === 0 && snapshot.phase !== "claimed") {
          input.setDraft(draft + leadFor(draft) + text);
          return true;
        }
        if (snapshot.draftRev === undefined) return false;
        var at = appendOffset(snapshot);
        actx.emit("slash/input-insert-text", {
          text: leadFor(draft) + text,
          span: { draftRev: snapshot.draftRev, start: at, end: at }
        });
        return true;
      } catch (error) {
        console.warn("[dsh-paper-reader] composer insert failed:", error);
        return false;
      }
    }

    // ── data helpers ─────────────────────────────────────────────────────────

    /* Highlights paint over the canvas, so their color keeps an alpha channel:
       the painted glyphs stay readable instead of being covered by a solid block. */
    function tintOf(color, alpha) {
      if (typeof color !== "string") return "rgba(255,213,79," + alpha + ")";
      var hex = color.trim();
      if (hex.charAt(0) !== "#" || hex.length !== 7) return hex;
      var red = parseInt(hex.slice(1, 3), 16);
      var green = parseInt(hex.slice(3, 5), 16);
      var blue = parseInt(hex.slice(5, 7), 16);
      if (!isFinite(red) || !isFinite(green) || !isFinite(blue)) return hex;
      return "rgba(" + red + "," + green + "," + blue + "," + alpha + ")";
    }

    function baseName(path) {
      if (typeof path !== "string") return "";
      var parts = path.split("/");
      return parts[parts.length - 1] || "";
    }

    function relativeTo(root, path) {
      if (typeof root !== "string" || typeof path !== "string") return "";
      if (path.indexOf(root) !== 0) return path;
      var rest = path.slice(root.length).replace(/^\/+/, "");
      return rest === "" ? "." : rest;
    }

    function clamp01(value) {
      return Math.min(Math.max(value, 0), 1);
    }

    function rectUnion(a, b) {
      if (a === null) return b;
      var left = Math.min(a.left, b.left);
      var top = Math.min(a.top, b.top);
      var right = Math.max(a.right, b.right);
      var bottom = Math.max(a.bottom, b.bottom);
      return { left: left, top: top, right: right, bottom: bottom, width: right - left, height: bottom - top };
    }

    function uid() {
      try {
        if (window.crypto && window.crypto.randomUUID !== undefined) return window.crypto.randomUUID();
      } catch (error) {
        /* fall through */
      }
      return "a-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    }

    function quoteLines(text) {
      return text
        .split("\n")
        .map(function (line) { return "> " + line; })
        .join("\n");
    }

    // ── document thumbnails ─────────────────────────────────────────────────

    var THUMB_CACHE = {};
    var thumbQueue = Promise.resolve();

    function DocThumb(props) {
      var docId = props.docId;
      var cachedPair = useState(THUMB_CACHE[docId] === undefined ? null : THUMB_CACHE[docId]);
      var thumb = cachedPair[0];
      var setThumb = cachedPair[1];

      useEffect(function () {
        if (THUMB_CACHE[docId] !== undefined) {
          setThumb(THUMB_CACHE[docId]);
          return undefined;
        }
        var cancelled = false;
        /* One page-one render at a time: opening the library must not fire a
           burst of full-document parses. */
        thumbQueue = thumbQueue.then(function () {
          if (cancelled) return null;
          return loadPdfLib()
            .then(function (pdfjs) {
              return pdfjs.getDocument({ url: "/paper-reader/file?id=" + encodeURIComponent(docId) }).promise;
            })
            .then(function (document_) {
              return document_.getPage(1).then(function (page) {
                var base = page.getViewport({ scale: 1 });
                var viewport = page.getViewport({ scale: 220 / base.width });
                var canvas = document.createElement("canvas");
                canvas.width = Math.ceil(viewport.width);
                canvas.height = Math.ceil(viewport.height);
                return page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport }).promise.then(function () {
                  var data = canvas.toDataURL("image/jpeg", 0.72);
                  THUMB_CACHE[docId] = data;
                  try { document_.destroy(); } catch (error) { /* already gone */ }
                  return data;
                });
              });
            })
            .catch(function () { return null; });
        });
        thumbQueue.then(function (data) {
          if (!cancelled && data !== null) setThumb(data);
        });
        return function () { cancelled = true; };
      }, [docId]);

      if (thumb !== null) return h("img", { className: "pr-doc-thumb-img", src: thumb, alt: "" });
      return h("div", { className: "pr-doc-thumb-ph" }, h(Icon, { name: "file", size: 22 }));
    }

    // ── page component ───────────────────────────────────────────────────────

    function PdfPage(props) {
      var pdf = props.pdf;
      var pageNumber = props.pageNumber;
      var scale = props.scale;
      var width = props.width;
      var height = props.height;
      var annotations = props.annotations;
      var highlightColor = props.highlightColor;
      var noteColor = props.noteColor;
      var flashId = props.flashId;

      var holderRef = useRef(null);
      var canvasRef = useRef(null);
      var textRef = useRef(null);

      useEffect(function () {
        if (!props.shouldRender) return undefined;
        var cancelled = false;
        var renderTask = null;
        var textTask = null;
        (async function () {
          var page = await pdf.getPage(pageNumber);
          if (cancelled) return;
          var viewport = page.getViewport({ scale: scale });
          var canvas = canvasRef.current;
          if (canvas === null) return;
          var context = canvas.getContext("2d", { alpha: false });
          var ratio = Math.min(window.devicePixelRatio || 1, 2);
          canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
          canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
          canvas.style.width = Math.floor(viewport.width) + "px";
          canvas.style.height = Math.floor(viewport.height) + "px";
          renderTask = page.render({
            canvasContext: context,
            viewport: viewport,
            transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0]
          });
          await renderTask.promise;
          if (cancelled) return;
          var textLayer = textRef.current;
          if (textLayer === null) return;
          textLayer.textContent = "";
          textLayer.style.width = Math.floor(viewport.width) + "px";
          textLayer.style.height = Math.floor(viewport.height) + "px";
          textLayer.style.setProperty("--scale-factor", String(viewport.scale));
          var textContent = await page.getTextContent();
          if (cancelled) return;
          textTask = window.pdfjsLib.renderTextLayer({
            textContentSource: textContent,
            container: textLayer,
            viewport: viewport,
            textDivs: []
          });
          await textTask.promise;
        })().catch(function (error) {
          if (error && error.name === "RenderingCancelledException") return;
          console.warn("[dsh-paper-reader] page render failed:", error);
        });
        return function () {
          cancelled = true;
          try { if (renderTask !== null) renderTask.cancel(); } catch (error) { /* already done */ }
          try { if (textTask !== null) textTask.cancel(); } catch (error) { /* already done */ }
        };
      }, [props.shouldRender, scale, pageNumber, pdf]);

      return h(
        "div",
        {
          ref: holderRef,
          className: "pr-page",
          "data-pr-page": String(pageNumber),
          style: { width: Math.floor(width) + "px", height: Math.floor(height) + "px" }
        },
        h("canvas", { ref: canvasRef, className: "pr-canvas" }),
        h("div", { ref: textRef, className: "pr-text-layer" }),
        h(
          "div",
          { className: "pr-hl-layer" },
          annotations.map(function (annotation) {
            return annotation.rects.map(function (rect, index) {
              var isNote = annotation.kind === "note";
              return h("div", {
                key: annotation.id + "-" + index,
                className: "pr-hl" + (isNote ? " pr-hl-note" : "") + (flashId === annotation.id ? " pr-hl-flash" : ""),
                style: {
                  left: (rect[0] * 100).toFixed(3) + "%",
                  top: (rect[1] * 100).toFixed(3) + "%",
                  width: (rect[2] * 100).toFixed(3) + "%",
                  height: (rect[3] * 100).toFixed(3) + "%",
                  background: tintOf(isNote ? noteColor : highlightColor, isNote ? 0.32 : 0.42)
                }
              });
            });
          })
        )
      );
    }

    // ── main tab component ───────────────────────────────────────────────────

    function PaperReader(props) {
      var ctx = props.ctx;
      var scope = props.scope;
      var visible = props.visible;

      var langPair = useState(langOf(ctx));
      var lang = langPair[0];
      var setLang = langPair[1];

      var libraryPair = useState(null);
      var library = libraryPair[0];
      var setLibrary = libraryPair[1];

      var docIdPair = useState(null);
      var docId = docIdPair[0];
      var setDocId = docIdPair[1];

      var metaPair = useState(null);
      var meta = metaPair[0];
      var setMeta = metaPair[1];

      var pdfPair = useState(null);
      var pdf = pdfPair[0];
      var setPdf = pdfPair[1];

      var sizesPair = useState(null);
      var pageSizes = sizesPair[0];
      var setPageSizes = sizesPair[1];

      var zoomPair = useState(1);
      var zoom = zoomPair[0];
      var setZoom = zoomPair[1];

      var pagePair = useState(1);
      var currentPage = pagePair[0];
      var setCurrentPage = pagePair[1];

      var rangePair = useState([1, 3]);
      var renderRange = rangePair[0];
      var setRenderRange = rangePair[1];

      var annotationPair = useState([]);
      var annotations = annotationPair[0];
      var setAnnotations = annotationPair[1];

      var selectionPair = useState(null);
      var selection = selectionPair[0];
      var setSelection = selectionPair[1];

      var notePair = useState(null);
      var noteEditor = notePair[0];
      var setNoteEditor = notePair[1];

      var busyPair = useState("");
      var busy = busyPair[0];
      var setBusy = busyPair[1];

      var errorPair = useState(null);
      var error = errorPair[0];
      var setError = errorPair[1];

      var libraryOpenPair = useState(false);
      var libraryOpen = libraryOpenPair[0];
      var setLibraryOpen = libraryOpenPair[1];

      var notesOpenPair = useState(false);
      var notesOpen = notesOpenPair[0];
      var setNotesOpen = notesOpenPair[1];

      var moreOpenPair = useState(false);
      var moreOpen = moreOpenPair[0];
      var setMoreOpen = moreOpenPair[1];

      var dragPair = useState(false);
      var dragOver = dragPair[0];
      var setDragOver = dragPair[1];

      var toastPair = useState(null);
      var toast = toastPair[0];
      var setToast = toastPair[1];

      var confirmPair = useState(null);
      var confirmId = confirmPair[0];
      var setConfirmId = confirmPair[1];

      var flashPair = useState(null);
      var flashId = flashPair[0];
      var setFlashId = flashPair[1];

      var widthPair = useState(0);
      var availableWidth = widthPair[0];
      var setAvailableWidth = widthPair[1];


      var settingsPair = useState(null);
      var settings = settingsPair[0];
      var setSettings = settingsPair[1];

      var parsePair = useState(null);
      var parse = parsePair[0];
      var setParse = parsePair[1];

      var panelTabPair = useState("notes");
      var panelTab = panelTabPair[0];
      var setPanelTab = panelTabPair[1];

      var treePair = useState(null);
      var tree = treePair[0];
      var setTree = treePair[1];

      var codeDraftPair = useState(null);
      var codeDraft = codeDraftPair[0];
      var setCodeDraft = codeDraftPair[1];

      var viewportRef = useRef(null);
      var bodyRef = useRef(null);
      var pageEls = useRef({});
      var pdfRef = useRef(null);
      var restoreRef = useRef(null);
      var saveTimer = useRef(null);
      var positionTimer = useRef(null);
      var toastTimer = useRef(null);
      var docIdRef = useRef(null);
      var fileInputRef = useRef(null);
      var autoOpenRef = useRef(false);
      var scrollFrame = useRef(0);
      var annotationsRef = useRef([]);
      var parseTimer = useRef(null);
      var atHintSeen = useRef({});
      var codeTimer = useRef(null);

      docIdRef.current = docId;
      annotationsRef.current = annotations;

      var t = useCallback(function (key) {
        return textOf(lang, key);
      }, [lang]);

      var atHintPair = useState(false);
      var atHint = atHintPair[0];
      var setAtHint = atHintPair[1];

      // The hint stays until the reader dismisses it or uses the button, so a
      // re-render of this tab cannot swallow it before it is read.
      function showAtHint(id) {
        if (typeof id !== "string" || id === "" || atHintSeen.current[id] === true) return;
        setAtHint(true);
      }

      function dismissAtHint() {
        setAtHint(false);
        if (docIdRef.current !== null) atHintSeen.current[docIdRef.current] = true;
      }

      function showToast(message) {
        setToast(message);
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(function () { setToast(null); }, 2600);
      }

      // Locale changes re-render the copy in place.
      useEffect(function () {
        var dispose = ctx.on("locale/change", function () { setLang(langOf(ctx)); });
        return typeof dispose === "function" ? dispose : function () {};
      }, [ctx]);

      useEffect(function () {
        void loadSettings();
      }, []);

      useEffect(function () {
        if (docId !== null) void refreshParse(docId);
      }, [docId]);

      // Composer focus reported by the host is a hint only; the insertion path
      // works whether or not the composer has been touched this session.

      function refreshLibrary() {
        return getJson(API_BASE + "library").then(function (body) {
          setLibrary(body.docs === undefined ? [] : body.docs);
          return body.docs;
        }).catch(function (errorValue) {
          console.warn("[dsh-paper-reader] library load failed:", errorValue);
          setLibrary([]);
          return [];
        });
      }

      // ── settings, MinerU and linked code ─────────────────────────────────

      function loadSettings() {
        return getSettings().then(function (value) {
          setSettings(value);
          return value;
        }).catch(function (errorValue) {
          console.warn("[dsh-paper-reader] settings load failed:", errorValue);
          return null;
        });
      }

      function applyParseState(state) {
        if (state !== null && state !== undefined && state.status === "done") showAtHint(docIdRef.current);
        setParse(state);
        setMeta(function (previous) {
          return previous === null ? previous : Object.assign({}, previous, { parse: state });
        });
      }

      function refreshParse(id) {
        if (typeof id !== "string" || id === "") return Promise.resolve(null);
        return readParse(id).then(function (state) {
          applyParseState(state);
          if (state !== null && state.status === "running") pollParse(id);
          return state;
        }).catch(function () { return null; });
      }

      function pollParse(id) {
        if (parseTimer.current !== null) clearTimeout(parseTimer.current);
        parseTimer.current = setTimeout(function () {
          readParse(id).then(function (state) {
            applyParseState(state);
            if (state !== null && state.status === "running") pollParse(id);
            else if (state !== null && state.status === "done") showToast(t("parseDone"));
            else if (state !== null && state.status === "error") showToast(t("parseFailed"));
          }).catch(function () { parseTimer.current = null; });
        }, 1500);
      }

      /** Open the plugin page where every setting lives. */
      function openSettingsPage() {
        setMoreOpen(false);
        try {
          var navigation = ctx.get("pluginNavigation");
          if (navigation !== undefined && navigation !== null && typeof navigation.openBundle === "function") {
            navigation.openBundle("dsh-paper-reader");
            return;
          }
          var layout = ctx.get("layout");
          if (layout !== undefined && layout !== null && typeof layout.selectPanel === "function") {
            layout.selectPanel("plugins");
            return;
          }
        } catch (errorValue) {
          console.warn("[dsh-paper-reader] settings navigation failed:", errorValue);
        }
        showToast(t("settingsFailed"));
      }

      function runParse(engine) {
        if (docId === null) return;
        var target = engine === "mineru" ? "mineru" : "markdown";
        if (target === "mineru") {
          if (settings === null || settings.mineruApiKeySet !== true) {
            showToast(t("parseNoKey"));
            openSettingsPage();
            return;
          }
        }
        setMoreOpen(false);
        startParse(docId, target).then(function (state) {
          applyParseState(state);
          showToast(target === "mineru" ? t("parseSwitched") : t("parseRunning"));
          pollParse(docId);
        }).catch(function (errorValue) {
          showToast(t("parseFailed") + (errorValue && errorValue.message ? ": " + errorValue.message : ""));
        });
      }

      /** Write the paper's folder (and its code situation) into the composer. */
      function insertPaperPath() {
        if (docId === null) return;
        dismissAtHint();
        if (parsing) {
          showToast(t("pathBusy"));
          return;
        }
        var title = meta === null ? t("untitled") : meta.title;
        readPaperFolder(docId).then(function (folder) {
          var lines = lang === "zh"
            ? ["请阅读这篇论文的工作目录：" + folder.path, "", "- 论文：" + title, "- 原文：pdf/" + baseName(folder.pdf)]
            : ["Read the working folder of this paper: " + folder.path, "", "- paper: " + title, "- original: pdf/" + baseName(folder.pdf)];
          if (folder.markdown !== "") {
            lines.push((lang === "zh" ? "- Markdown：" : "- markdown: ") + relativeTo(folder.path, folder.markdown));
          } else {
            lines.push(lang === "zh" ? "- Markdown：尚未解析" : "- markdown: not parsed yet");
          }
          if (folder.code.repo !== "") lines.push((lang === "zh" ? "- 代码仓库：" : "- code repository: ") + folder.code.repo);
          else if (folder.code.path !== "") lines.push((lang === "zh" ? "- 本地代码：" : "- local code: ") + folder.code.path);
          else lines.push(lang === "zh" ? "- 代码：论文未提供开源实现，可在 code/ 下按论文自行实现" : "- code: no official implementation; implement it under code/");
          var ok = appendToComposer(ctx, scope.sessionId, lines.join("\n"));
          showToast(ok ? t("askQueued") : t("askFailed"));
        }).catch(function (errorValue) {
          showToast(t("pathFailed") + (errorValue && errorValue.message ? ": " + errorValue.message : ""));
        });
      }

      function browseCode(path) {
        readTree(path).then(function (listing) {
          setTree(listing);
        }).catch(function (errorValue) {
          setTree({ path: path, entries: [], error: errorValue && errorValue.message ? errorValue.message : String(errorValue) });
        });
      }

      function saveCodeLink() {
        if (docId === null || codeDraft === null) return;
        var previousNote = meta !== null && meta.code !== undefined ? meta.code.note : "";
        var next = {
          repo: typeof codeDraft.repo === "string" ? codeDraft.repo.trim() : "",
          path: typeof codeDraft.path === "string" ? codeDraft.path.trim() : "",
          note: previousNote
        };
        setMeta(function (previous) {
          return previous === null ? previous : Object.assign({}, previous, { code: next });
        });
        patchDoc(docId, { code: next }).then(function () {
          showToast(t("saved"));
          if (next.path !== "") browseCode(next.path);
          void refreshLibrary();
        }).catch(function (errorValue) {
          showToast(t("saveFailed") + (errorValue && errorValue.message ? ": " + errorValue.message : ""));
        });
      }

      function jumpToSession(annotation) {
        var sessionId = annotation === undefined || annotation === null ? "" : annotation.sourceSessionId;
        if (typeof sessionId !== "string" || sessionId === "") {
          showToast(t("noSession"));
          return;
        }
        try {
          var workspace = ctx.get("uiWorkspace");
          if (workspace !== undefined && workspace !== null && typeof workspace.openSession === "function") {
            workspace.openSession(sessionId);
            return;
          }
        } catch (errorValue) {
          console.warn("[dsh-paper-reader] openSession failed:", errorValue);
        }
        showToast(t("noSession"));
      }

      function copyLocationLink(annotation) {
        var link = "paper://" + String(docId) + "@p" + String(annotation.page);
        try {
          navigator.clipboard.writeText(link).then(function () { showToast(t("linkCopied")); });
        } catch (errorValue) {
          console.warn("[dsh-paper-reader] clipboard failed:", errorValue);
        }
      }

      function askAboutFile(entry) {
        if (tree === null) return;
        var absolute = tree.path.replace(/\/+$/, "") + "/" + entry.name;
        var title = meta === null ? t("untitled") : meta.title;
        var lead = lang === "zh"
          ? "请读一下这个文件，并把它与论文《" + title + "》第 " + currentPage + " 页的方法描述对照，指出实现与论文的差异："
          : "Read this file and compare it with the method described on page " + currentPage + " of \"" + title + "\":";
        var prompt = lead + "\n\n" + absolute;
        var ok = appendToComposer(ctx, scope.sessionId, prompt);
        showToast(ok ? t("askQueued") : t("askFailed"));
      }

      function updateRenderRange(scrollTop, viewportHeight) {
        if (pageSizes === null || availableWidth <= 0) return;
        var rangeStart = 1;
        var rangeEnd = 1;
        var found = false;
        var top = 0;
        for (var index = 0; index < pageSizes.length; index += 1) {
          var scale = (availableWidth / pageSizes[index].width) * zoom;
          var height = pageSizes[index].height * scale + 12;
          var bottom = top + height;
          if (bottom > scrollTop - 1600 && top < scrollTop + viewportHeight + 1600) {
            if (!found) {
              rangeStart = index + 1;
              found = true;
            }
            rangeEnd = index + 1;
          }
          top = bottom;
        }
        setRenderRange(function (previous) {
          return previous[0] === rangeStart && previous[1] === rangeEnd ? previous : [rangeStart, rangeEnd];
        });
      }

      function destroyPdf() {
        if (pdfRef.current !== null) {
          try { pdfRef.current.destroy(); } catch (error) { /* already destroyed */ }
          pdfRef.current = null;
        }
      }

      function openDoc(id) {
        if (typeof id !== "string" || id === "") return Promise.resolve();
        destroyPdf();
        setBusy("open");
        setError(null);
        setLibraryOpen(false);
        setNotesOpen(false);
        setMoreOpen(false);
        setAtHint(false);
        setPanelTab("notes");
        setTree(null);
        setCodeDraft(null);
        setSelection(null);
        setNoteEditor(null);
        return getJson(API_BASE + "doc?id=" + encodeURIComponent(id))
          .then(function (body) {
            var docMeta = body.doc;
            return loadPdfLib().then(function (pdfjs) {
              var task = pdfjs.getDocument({
                url: "/paper-reader/file?id=" + encodeURIComponent(id),
                cMapUrl: STATIC_BASE + "cmaps/",
                cMapPacked: true,
                standardFontDataUrl: STATIC_BASE + "standard_fonts/"
              });
              return task.promise.then(function (document_) {
                var sizes = [];
                var chain = Promise.resolve();
                for (var n = 1; n <= document_.numPages; n += 1) {
                  /* eslint-disable no-loop-func */
                  (function (pageNumber) {
                    chain = chain.then(function () {
                      return document_.getPage(pageNumber).then(function (page) {
                        var viewport = page.getViewport({ scale: 1 });
                        sizes.push({ width: viewport.width, height: viewport.height });
                      });
                    });
                  })(n);
                  /* eslint-enable no-loop-func */
                }
                return chain.then(function () {
                  pdfRef.current = document_;
                  setPdf(document_);
                  setPageSizes(sizes);
                  setMeta(Object.assign({}, docMeta, { pageCount: document_.numPages }));
                  setAnnotations(Array.isArray(docMeta.annotations) ? docMeta.annotations : []);
                  setDocId(id);
                  setZoom(1);
                  setCurrentPage(1);
                  setRenderRange([1, 3]);
                  restoreRef.current = {
                    page: Number.isInteger(docMeta.lastPage) && docMeta.lastPage > 0 ? docMeta.lastPage : 1,
                    ratio: Number.isFinite(docMeta.scrollRatio) ? docMeta.scrollRatio : 0
                  };
                  try { localStorage.setItem(LAST_DOC_KEY + ":" + scope.sessionId, id); } catch (error) { /* private mode */ }
                  if (docMeta.pageCount !== document_.numPages) {
                    patchDoc(id, { pageCount: document_.numPages }).catch(function () { /* non-fatal */ });
                  }
                });
              });
            });
          })
          .catch(function (errorValue) {
            if (errorValue && errorValue.status === 404) {
              try { localStorage.removeItem(LAST_DOC_KEY + ":" + scope.sessionId); } catch (error) { /* private mode */ }
              setMeta(null);
              setPdf(null);
              setPageSizes(null);
              setDocId(null);
              setError(null);
              showToast(t("deleted"));
              return;
            }
            setPdf(null);
            setPageSizes(null);
            setMeta(null);
            setError(errorValue && errorValue.message ? errorValue.message : String(errorValue));
          })
          .then(function () {
            setBusy("");
          });
      }

      // Load the library once per session.
      useEffect(function () {
        autoOpenRef.current = false;
        void refreshLibrary();
        return function () {
          if (saveTimer.current !== null) clearTimeout(saveTimer.current);
          if (positionTimer.current !== null) clearTimeout(positionTimer.current);
          if (toastTimer.current !== null) clearTimeout(toastTimer.current);
          destroyPdf();
        };
        // The tab body is per session; a remount under another session runs again.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [scope.sessionId]);

      // Reopen the last paper only once the tab is visible: pdf.js resources can
      // stall while the sidebar tab sits in a throttled background tab.
      useEffect(function () {
        if (visible === false || autoOpenRef.current || library === null) return;
        autoOpenRef.current = true;
        var last = null;
        try { last = localStorage.getItem(LAST_DOC_KEY + ":" + scope.sessionId); } catch (error) { /* private mode */ }
        if (last !== null && last !== "") {
          void openDoc(last);
        } else if (library.length > 0) {
          void openDoc(library[0].id);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [visible, library, scope.sessionId]);

      // Measure the reading column; every page is laid out to fit it. The
      // observed element is the body, which stays mounted across the settings
      // view, and the effect re-arms whenever the view or tab visibility
      // changes so a returning reader never keeps a stale width.
      function measureWidth() {
        var body = bodyRef.current;
        if (body === null) return;
        var width = body.clientWidth - 20;
        var next = width > 120 ? width : 120;
        setAvailableWidth(function (previous) {
          return Math.abs(previous - next) < 0.5 ? previous : next;
        });
        if (typeof updateRenderRange === "function") {
          var viewport = viewportRef.current;
          if (viewport !== null) updateRenderRange(viewport.scrollTop, viewport.clientHeight);
        }
      }

      useEffect(function () {
        measureWidth();
        if (typeof ResizeObserver === "undefined") {
          window.addEventListener("resize", measureWidth);
          return function () { window.removeEventListener("resize", measureWidth); };
        }
        var target = bodyRef.current;
        if (target === null) return undefined;
        var observer = new ResizeObserver(measureWidth);
        observer.observe(target);
        return function () { observer.disconnect(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pdf === null, visible, notesOpen, libraryOpen]);

      // Recompute which pages should hold a canvas when geometry changes.
      useEffect(function () {
        if (pdf === null || pageSizes === null) return undefined;
        var viewport = viewportRef.current;
        if (viewport !== null) updateRenderRange(viewport.scrollTop, viewport.clientHeight);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pdf, pageSizes, availableWidth, zoom]);

      // Restore the reading position once page geometry exists.
      useEffect(function () {
        if (pdf === null || pageSizes === null || availableWidth <= 0) return undefined;
        var target = restoreRef.current;
        if (target === null) return undefined;
        restoreRef.current = null;
        var timer = setTimeout(function () { scrollToPage(target.page, target.ratio); }, 80);
        return function () { clearTimeout(timer); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pdf, pageSizes, availableWidth]);

      function scrollToPage(page, ratio) {
        var viewport = viewportRef.current;
        var element = pageEls.current[page];
        if (viewport === null || element === undefined) return;
        var offset = element.offsetTop + (Number.isFinite(ratio) ? ratio : 0) * element.offsetHeight;
        viewport.scrollTop = Math.max(0, offset - 8);
        setCurrentPage(page);
      }

      function schedulePosition(page, ratio) {
        if (positionTimer.current !== null) clearTimeout(positionTimer.current);
        var id = docIdRef.current;
        if (id === null) return;
        positionTimer.current = setTimeout(function () {
          if (docIdRef.current !== id) return;
          var clamp = Math.min(Math.max(ratio, 0), 1);
          patchDoc(id, { lastPage: page, scrollRatio: clamp }).catch(function () { /* non-fatal */ });
        }, 900);
      }

      function onScroll() {
        if (scrollFrame.current !== 0) return;
        scrollFrame.current = window.requestAnimationFrame(function () {
          scrollFrame.current = 0;
          var viewport = viewportRef.current;
          if (viewport === null || pageSizes === null) return;
          var probe = viewport.scrollTop + viewport.clientHeight * 0.32;
          var page = 1;
          var element = pageEls.current[1];
          for (var n = 1; n <= pageSizes.length; n += 1) {
            var candidate = pageEls.current[n];
            if (candidate !== undefined && candidate.offsetTop <= probe) {
              page = n;
              element = candidate;
            }
          }
          setCurrentPage(page);
          updateRenderRange(viewport.scrollTop, viewport.clientHeight);
          if (element !== undefined) {
            var ratio = (viewport.scrollTop - element.offsetTop) / Math.max(1, element.offsetHeight);
            schedulePosition(page, ratio);
          }
          if (selection !== null) setSelection(null);
        });
      }

      function mutateAnnotations(mutator) {
        var id = docIdRef.current;
        setAnnotations(function (previous) {
          var next = mutator(previous);
          if (saveTimer.current !== null) clearTimeout(saveTimer.current);
          if (id !== null) {
            saveTimer.current = setTimeout(function () {
              if (docIdRef.current !== id) return;
              patchDoc(id, { annotations: next }).catch(function (errorValue) {
                console.warn("[dsh-paper-reader] annotation save failed:", errorValue);
                showToast(textOf(langOf(ctx), "saveFailed"));
              });
            }, 350);
          }
          return next;
        });
      }

      function captureSelection() {
        var viewport = viewportRef.current;
        var domSelection = window.getSelection();
        if (viewport === null || domSelection === null || domSelection.rangeCount === 0 || domSelection.isCollapsed) {
          setSelection(null);
          return;
        }
        var text = domSelection.toString().replace(/\u00a0/g, " ").replace(/\s+$/, "");
        if (text.trim() === "") {
          setSelection(null);
          return;
        }
        var anchorInside = viewport.contains(domSelection.anchorNode);
        var focusInside = viewport.contains(domSelection.focusNode);
        if (!anchorInside && !focusInside) {
          setSelection(null);
          return;
        }
        var groups = {};
        var order = [];
        var union = null;
        for (var i = 0; i < domSelection.rangeCount; i += 1) {
          var range = domSelection.getRangeAt(i);
          var rects = range.getClientRects();
          for (var j = 0; j < rects.length; j += 1) {
            var rect = rects[j];
            if (rect.width < 1.5 || rect.height < 1.5) continue;
            var pointX = rect.left + rect.width / 2;
            var pointY = rect.top + rect.height / 2;
            var element = document.elementFromPoint(pointX, pointY);
            var pageElement = element !== null && element.closest !== undefined ? element.closest("[data-pr-page]") : null;
            if (pageElement === null || !viewport.contains(pageElement)) continue;
            var page = Number(pageElement.getAttribute("data-pr-page"));
            var box = pageElement.getBoundingClientRect();
            if (box.width < 1 || box.height < 1) continue;
            var normX = clamp01((rect.left - box.left) / box.width);
            var normY = clamp01((rect.top - box.top) / box.height);
            var normW = clamp01((rect.right - box.left) / box.width) - normX;
            var normH = clamp01((rect.bottom - box.top) / box.height) - normY;
            if (normW <= 0.001 || normH <= 0.001) continue;
            if (groups[page] === undefined) {
              groups[page] = [];
              order.push(page);
            }
            var duplicate = groups[page].some(function (existing) {
              return Math.abs(existing[0] - normX) < 0.004
                && Math.abs(existing[1] - normY) < 0.004
                && Math.abs(existing[2] - normW) < 0.004
                && Math.abs(existing[3] - normH) < 0.004;
            });
            if (!duplicate) groups[page].push([normX, normY, normW, normH]);
            union = rectUnion(union, rect);
          }
        }
        if (union === null || order.length === 0) {
          setSelection(null);
          return;
        }
        order.sort(function (a, b) { return a - b; });
        setSelection({
          text: text,
          pages: order.map(function (page) { return { page: page, rects: groups[page] }; }),
          rect: union
        });
      }

      function onViewportMouseUp(event) {
        if (event.target !== null && event.target.closest !== undefined && event.target.closest(".pr-popup, .pr-note-pop")) return;
        window.setTimeout(captureSelection, 0);
      }

      useEffect(function () {
        function onSelectionChange() {
          var domSelection = window.getSelection();
          if (domSelection === null || domSelection.isCollapsed) setSelection(null);
        }
        document.addEventListener("selectionchange", onSelectionChange);
        return function () { document.removeEventListener("selectionchange", onSelectionChange); };
      }, []);

      useEffect(function () {
        function onKeyDown(event) {
          if (event.key === "Escape") {
            setSelection(null);
            setNoteEditor(null);
            setMoreOpen(false);
            setLibraryOpen(false);
            setNotesOpen(false);
          }
        }
        document.addEventListener("keydown", onKeyDown);
        return function () { document.removeEventListener("keydown", onKeyDown); };
      }, []);

      function addHighlight() {
        if (selection === null) return;
        var now = Date.now();
        var created = selection.pages.map(function (group) {
          return {
            id: uid(),
            kind: "highlight",
            page: group.page,
            rects: group.rects,
            text: selection.text,
            note: "",
            color: HIGHLIGHT_COLOR,
            author: "human",
            sourceSessionId: scope !== undefined && scope !== null ? String(scope.sessionId) : "",
            createdAt: now,
            updatedAt: now
          };
        });
        mutateAnnotations(function (previous) { return previous.concat(created); });
        setSelection(null);
        var domSelection = window.getSelection();
        if (domSelection !== null) domSelection.removeAllRanges();
      }

      function beginNote() {
        if (selection === null) return;
        setNoteEditor({
          pages: selection.pages,
          text: selection.text,
          rect: selection.rect,
          id: null,
          note: ""
        });
        setSelection(null);
      }

      function editNote(annotation) {
        var rects = annotation.rects.map(function (rect) { return rect.slice(); });
        setNoteEditor({
          pages: [{ page: annotation.page, rects: rects }],
          text: annotation.text,
          rect: null,
          id: annotation.id,
          note: annotation.note,
          page: annotation.page
        });
        setNotesOpen(false);
      }

      function saveNote(noteText) {
        if (noteEditor === null) return;
        var now = Date.now();
        var value = noteText.trim();
        if (value === "") {
          setNoteEditor(null);
          return;
        }
        if (noteEditor.id !== null) {
          var id = noteEditor.id;
          mutateAnnotations(function (previous) {
            return previous.map(function (annotation) {
              return annotation.id === id
                ? Object.assign({}, annotation, { note: value, updatedAt: now })
                : annotation;
            });
          });
          setNoteEditor(null);
          return;
        }
        var created = noteEditor.pages.map(function (group, index) {
          return {
            id: uid(),
            kind: index === 0 ? "note" : "highlight",
            page: group.page,
            rects: group.rects,
            text: noteEditor.text,
            note: index === 0 ? value : "",
            color: index === 0 ? NOTE_COLOR : HIGHLIGHT_COLOR,
            author: "human",
            sourceSessionId: scope !== undefined && scope !== null ? String(scope.sessionId) : "",
            createdAt: now,
            updatedAt: now
          };
        });
        mutateAnnotations(function (previous) { return previous.concat(created); });
        setNoteEditor(null);
      }

      function removeAnnotation(id) {
        mutateAnnotations(function (previous) {
          return previous.filter(function (annotation) { return annotation.id !== id; });
        });
        if (noteEditor !== null && noteEditor.id === id) setNoteEditor(null);
      }

      function buildPrompt() {
        if (selection === null) return "";
        var quoteText = selection.text;
        if (quoteText.length > MAX_PROMPT_QUOTE) quoteText = quoteText.slice(0, MAX_PROMPT_QUOTE) + "…";
        var title = meta === null ? t("untitled") : meta.title;
        var page = selection.pages.length > 0 ? selection.pages[0].page : currentPage;
        var heading = t("promptHeading");
        var from = formatString(t("promptFrom"), { title: title, page: page });
        return heading + "\n\n" + quoteLines(quoteText) + "\n\n" + from;
      }

      function askInConversation() {
        if (selection === null) return;
        var prompt = buildPrompt();
        var ok = appendToComposer(ctx, scope.sessionId, prompt);
        setSelection(null);
        var domSelection = window.getSelection();
        if (domSelection !== null) domSelection.removeAllRanges();
        showToast(ok ? t("askQueued") : t("askFailed"));
      }

      function chooseFile() {
        if (fileInputRef.current !== null) fileInputRef.current.click();
      }

      function handleFiles(files) {
        if (files === null || files === undefined || files.length === 0) return;
        var file = files[0];
        var isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
        if (!isPdf) {
          showToast(t("notPdf"));
          return;
        }
        setBusy("upload");
        setError(null);
        uploadFile(file)
          .then(function (doc) {
            return refreshLibrary().then(function () { return doc; });
          })
          .then(function (doc) {
            showToast(t("imported"));
            // Extracting text is silent and automatic; MinerU is an explicit switch in the reader.
            startParse(doc.id, "markdown").then(function (state) {
              applyParseState(state);
              pollParse(doc.id);
            }).catch(function () { /* a failed silent parse never blocks reading */ });
            return openDoc(doc.id);
          })
          .catch(function (errorValue) {
            setError(errorValue && errorValue.message ? errorValue.message : String(errorValue));
          })
          .then(function () { setBusy(""); });
      }

      function onFileInputChange(event) {
        var files = event.target.files;
        handleFiles(files);
        event.target.value = "";
      }

      function onDrop(event) {
        event.preventDefault();
        setDragOver(false);
        if (event.dataTransfer !== null && event.dataTransfer.files !== null) {
          handleFiles(event.dataTransfer.files);
        }
      }

      function removePaper(id) {
        if (confirmId !== id) {
          setConfirmId(id);
          setTimeout(function () { setConfirmId(function (current) { return current === id ? null : current; }); }, 3200);
          return;
        }
        setConfirmId(null);
        deleteDoc(id)
          .then(function () {
            showToast(t("deleted"));
            if (docIdRef.current === id) {
              destroyPdf();
              setMeta(null);
              setPdf(null);
              setPageSizes(null);
              setAnnotations([]);
              setDocId(null);
              try { localStorage.removeItem(LAST_DOC_KEY + ":" + scope.sessionId); } catch (error) { /* private mode */ }
            }
            return refreshLibrary();
          })
          .catch(function (errorValue) {
            showToast(errorValue && errorValue.message ? errorValue.message : String(errorValue));
          });
      }

      function goToPage(page) {
        if (pageSizes === null) return;
        var target = Math.min(Math.max(page, 1), pageSizes.length);
        scrollToPage(target, 0);
        setNotesOpen(false);
        setFlashId(null);
        setLibraryOpen(false);
      }

      function revealAnnotation(annotation) {
        goToPage(annotation.page);
        setFlashId(annotation.id);
        setTimeout(function () { setFlashId(function (current) { return current === annotation.id ? null : current; }); }, 1800);
      }

      function changeZoom(delta) {
        setZoom(function (previous) {
          var next = Math.round((previous + delta) * 10) / 10;
          return Math.min(Math.max(next, 0.6), 2.6);
        });
      }

      // ── derived values ───────────────────────────────────────────────────

      var pageCount = pageSizes === null ? 0 : pageSizes.length;
      var parsing = parse !== null && parse.status === "running";
      // Reopening a paper trusts the files on disk, not just the last job record.
      var mineruParsed = parse !== null && parse.engine === "mineru"
        && (parse.status === "done" || (meta !== null && meta.hasMarkdown === true));
      // Clicking again while MinerU itself runs would only restart it; a local
      // parse stays interruptible, which is the switch this entry offers.
      var mineruBusy = parsing && parse.engine === "mineru";
      var parsePercent = parse === null ? 0 : Math.round(Math.min(Math.max(parse.progress, 0), 1) * 100);
      var highlightCount = 0;
      var noteCount = 0;
      for (var index = 0; index < annotations.length; index += 1) {
        if (annotations[index].kind === "note") noteCount += 1;
        else highlightCount += 1;
      }
      var annotationsByPage = {};
      for (var j = 0; j < annotations.length; j += 1) {
        var annotation = annotations[j];
        if (annotationsByPage[annotation.page] === undefined) annotationsByPage[annotation.page] = [];
        annotationsByPage[annotation.page].push(annotation);
      }

      // ── render helpers ───────────────────────────────────────────────────

      function iconButton(name, label, onClick, extra) {
        return h(
          "button",
          Object.assign({
            type: "button",
            className: "pr-icon-btn",
            title: label,
            "aria-label": label,
            onClick: onClick
          }, extra === undefined ? {} : extra),
          h(Icon, { name: name, size: 16 })
        );
      }

      function renderToolbar() {
        return h(
          "div",
          { className: "pr-toolbar" },
          h(
            "button",
            {
              type: "button",
              className: "pr-title-btn",
              title: meta === null ? t("library") : meta.title,
              onClick: function () {
                setLibraryOpen(function (open) { return !open; });
                setNotesOpen(false);
                setMoreOpen(false);
                void refreshLibrary();
              }
            },
            h(Icon, { name: "book", size: 16 }),
            h("span", { className: "pr-title-text" }, meta === null ? t("library") : meta.title),
            h(Icon, { name: "chevronDown", size: 12 })
          ),
          h(
            "div",
            { className: "pr-toolbar-actions" },
            meta !== null
              ? iconButton("bookmark", t("annotations") + (annotations.length > 0 ? " (" + annotations.length + ")" : ""), function () {
                  setNotesOpen(function (open) { return !open; });
                  setLibraryOpen(false);
                  setMoreOpen(false);
                }, {
                  className: "pr-icon-btn" + (notesOpen ? " pr-icon-btn-active" : "")
                })
              : null,
            meta !== null
              ? h(
                  "div",
                  { className: "pr-zoom" },
                  iconButton("minus", t("zoomOut"), function () { changeZoom(-0.2); }),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "pr-zoom-level",
                      title: t("fitWidth"),
                      onClick: function () { measureWidth(); setZoom(1); }
                    },
                    Math.round(zoom * 100) + "%"
                  ),
                  iconButton("plus", t("zoomIn"), function () { changeZoom(0.2); })
                )
              : null,
            meta !== null
              ? iconButton("code", t("codeTab"), function () {
                  setPanelTab("code");
                  setNotesOpen(true);
                  setLibraryOpen(false);
                  setMoreOpen(false);
                  if (codeDraft === null) {
                    var codeState = meta.code !== undefined ? meta.code : { repo: "", path: "" };
                    setCodeDraft({ repo: codeState.repo, path: codeState.path });
                  }
                  if (meta.code !== undefined && meta.code.path !== "") browseCode(meta.code.path);
                }, {
                  className: "pr-icon-btn" + (notesOpen && panelTab === "code" ? " pr-icon-btn-active" : "")
                })
              : null,
            iconButton("upload", t("upload"), function () { chooseFile(); }),
            meta !== null
              ? h(
                  "button",
                  {
                    type: "button",
                    className: "pr-icon-btn pr-at-btn" + (parsing ? " pr-icon-btn-off" : ""),
                    title: parsing ? t("pathBusy") : t("atPath"),
                    "aria-label": t("atPath"),
                    disabled: parsing,
                    onClick: insertPaperPath
                  },
                  h(Icon, { name: "at", size: 16 })
                )
              : null,
            iconButton("more", t("more"), function () { setMoreOpen(function (open) { return !open; }); setLibraryOpen(false); setNotesOpen(false); })
          )
        );
      }

      function renderEmpty() {
        return h(
          "div",
          { className: "pr-empty" },
          h("div", { className: "pr-empty-icon" }, h(Icon, { name: "file", size: 26 })),
          h("div", { className: "pr-empty-title" }, t("emptyTitle")),
          h("div", { className: "pr-empty-desc" }, t("emptyDesc")),
          h(
            "button",
            { type: "button", className: "pr-btn pr-btn-primary", onClick: chooseFile },
            h(Icon, { name: "upload", size: 14 }),
            t("chooseFile")
          )
        );
      }

      function renderError() {
        return h(
          "div",
          { className: "pr-empty" },
          h("div", { className: "pr-empty-icon pr-empty-icon-error" }, h(Icon, { name: "info", size: 24 })),
          h("div", { className: "pr-empty-title" }, t("openFailed")),
          h("div", { className: "pr-empty-desc" }, error),
          h("div", { className: "pr-empty-hint" }, t("errorHint")),
          h(
            "div",
            { className: "pr-row" },
            h("button", { type: "button", className: "pr-btn", onClick: function () { setLibraryOpen(true); } }, t("library")),
            docId !== null ? h(
              "a",
              {
                className: "pr-btn",
                href: API_BASE + "file?id=" + encodeURIComponent(docId),
                download: (meta === null ? "paper" : meta.title) + ".pdf"
              },
              t("downloadOriginal")
            ) : null,
            docId !== null ? h("button", { type: "button", className: "pr-btn pr-btn-primary", onClick: function () { void openDoc(docId); } }, t("retry")) : null
          )
        );
      }

      function renderPages() {
        if (availableWidth <= 0) return null;
        return pageSizes.map(function (size, index) {
          var pageNumber = index + 1;
          var scale = (availableWidth / size.width) * zoom;
          return h(PdfPage, {
            key: pageNumber,
            pdf: pdf,
            pageNumber: pageNumber,
            scale: scale,
            width: size.width * scale,
            height: size.height * scale,
            annotations: annotationsByPage[pageNumber] === undefined ? [] : annotationsByPage[pageNumber],
            highlightColor: HIGHLIGHT_COLOR,
            noteColor: NOTE_COLOR,
            flashId: flashId,
            shouldRender: pageNumber >= renderRange[0] && pageNumber <= renderRange[1]
          });
        });
      }

      function renderLibrary() {
        if (!libraryOpen) return null;
        var body = null;
        if (library === null) {
          body = h("div", { className: "pr-panel-empty" }, "…");
        } else if (library.length === 0) {
          body = h("div", { className: "pr-panel-empty" }, t("emptyLibrary"));
        } else {
          body = h(
            "div",
            { className: "pr-list" },
            library.map(function (doc) {
              return renderDocCard(doc);
            })
          );
        }
        return h(
          "div",
          { className: "pr-panel" },
          h(
            "div",
            { className: "pr-panel-head" },
            h("span", { className: "pr-panel-title" }, t("library")),
            h(
              "button",
              { type: "button", className: "pr-btn pr-btn-primary pr-btn-small", onClick: chooseFile },
              h(Icon, { name: "plus", size: 13 }),
              t("uploadShort")
            ),
            iconButton("close", t("close"), function () { setLibraryOpen(false); })
          ),
          body
        );
      }

      function renderDocCard(doc) {
        var active = doc.id === docId;
        var confirming = confirmId === doc.id;
        var metaText = (doc.pageCount === null ? "" : t("pages")(doc.pageCount) + " · ")
          + formatBytes(doc.size) + " · " + formatDate(doc.updatedAt, lang);
        return h(
          "div",
          {
            key: doc.id,
            className: "pr-doc-card" + (active ? " pr-doc-card-active" : ""),
            title: doc.title,
            onClick: function () { void openDoc(doc.id); }
          },
          h("div", { className: "pr-doc-thumb" }, h(DocThumb, { docId: doc.id })),
          h("div", { className: "pr-doc-name" }, doc.title),
          h("div", { className: "pr-doc-meta" }, metaText),
          h(
            "button",
            {
              type: "button",
              className: "pr-doc-del" + (confirming ? " pr-doc-del-confirm" : ""),
              title: confirming ? t("confirmDelete") : t("deletePaper"),
              onClick: function (event) {
                event.stopPropagation();
                removePaper(doc.id);
              }
            },
            confirming ? t("confirmDelete") : h(Icon, { name: "trash", size: 13 })
          )
        );
      }

      function pollCode(baseline) {
        if (codeTimer.current !== null) clearTimeout(codeTimer.current);
        var tries = 0;
        function tick() {
          tries += 1;
          getJson(API_BASE + "doc?id=" + encodeURIComponent(docId)).then(function (body) {
            var next = body.doc !== undefined && body.doc.code !== undefined ? body.doc.code : { repo: "", path: "", note: "" };
            if (next.repo !== "" && next.repo !== baseline) {
              setMeta(function (previous) {
                return previous === null ? previous : Object.assign({}, previous, { code: next });
              });
              showToast(t("saved"));
              return;
            }
            if (tries < 15) codeTimer.current = setTimeout(tick, 4000);
          }).catch(function () {
            if (tries < 15) codeTimer.current = setTimeout(tick, 4000);
          });
        }
        codeTimer.current = setTimeout(tick, 4000);
      }

      function askForRepo() {
        if (docId === null) return;
        var title = meta === null ? t("untitled") : meta.title;
        var baseline = meta !== null && meta.code !== undefined ? meta.code.repo : "";
        var prompt = lang === "zh"
          ? "帮我确认这篇论文的官方开源实现，找到后调用 paper_annotations 工具（action=\"code\", docId=\"" + docId + "\", repo=\"<仓库地址>\"）把地址写回阅读器；找不到官方实现就直说，不要编造。\n\n论文：" + title
          : "Find the official open-source implementation of this paper, then call the paper_annotations tool (action=\"code\", docId=\"" + docId + "\", repo=\"<url>\") to record it in the reader. If no official implementation exists, say so — do not invent one.\n\nPaper: " + title;
        var ok = appendToComposer(ctx, scope.sessionId, prompt);
        showToast(ok ? t("askQueued") : t("askFailed"));
        if (ok) pollCode(baseline);
      }

      function askImplement() {
        var title = meta === null ? t("untitled") : meta.title;
        var code = meta !== null && meta.code !== undefined ? meta.code : { repo: "", path: "" };
        var prompt = lang === "zh"
          ? "请为这篇论文写一版最小可运行实现：先给模块划分与关键数据结构，再落代码，最后说明与论文不一致的取舍。\n\n论文：" + title + (code.repo !== "" ? "\n参考仓库：" + code.repo : "")
          : "Write a minimal runnable implementation of this paper: module breakdown and key data structures first, then the code, then the trade-offs that differ from the paper.\n\nPaper: " + title + (code.repo !== "" ? "\nReference repo: " + code.repo : "");
        var ok = appendToComposer(ctx, scope.sessionId, prompt);
        showToast(ok ? t("askQueued") : t("askFailed"));
      }

      function renderNoteBody() {
        var ordered = annotations.slice().sort(function (a, b) {
          return a.page === b.page ? a.createdAt - b.createdAt : a.page - b.page;
        });
        if (ordered.length === 0) return h("div", { className: "pr-panel-empty" }, t("noAnnotations"));
        return h(
          "div",
          { className: "pr-note-list" },
          ordered.map(function (annotation) {
            var isNote = annotation.kind === "note";
            var isAi = annotation.author === "ai";
            var primary = isNote && annotation.note !== "" ? annotation.note : annotation.text;
            if (primary === "") primary = isNote ? t("noteKind") : t("highlightKind");
            var tooltip = annotation.text + (annotation.note !== "" ? "\n\n" + annotation.note : "");
            return h(
              "div",
              {
                key: annotation.id,
                className: "pr-note-row",
                title: tooltip,
                onClick: function () { revealAnnotation(annotation); }
              },
              h("span", { className: "pr-page-chip" }, t("page").replace("{n}", String(annotation.page))),
              h(
                "span",
                { className: "pr-kind" + (isNote ? " pr-kind-note" : "") },
                isNote ? h(Icon, { name: "pencil", size: 11 }) : h(Icon, { name: "marker", size: 11 })
              ),
              isAi ? h("span", { className: "pr-author pr-author-ai" }, t("aiAuthor")) : null,
              h("span", { className: "pr-note-row-text" }, primary),
              h(
                "span",
                { className: "pr-note-row-actions" },
                h(
                  "button",
                  {
                    type: "button",
                    className: "pr-icon-btn pr-icon-btn-sm",
                    title: t("copyLink"),
                    onClick: function (event) { event.stopPropagation(); copyLocationLink(annotation); }
                  },
                  h(Icon, { name: "link", size: 12 })
                ),
                annotation.sourceSessionId !== undefined && annotation.sourceSessionId !== ""
                  ? h(
                      "button",
                      {
                        type: "button",
                        className: "pr-icon-btn pr-icon-btn-sm",
                        title: annotation.sourceSessionTitle !== undefined && annotation.sourceSessionTitle !== ""
                          ? t("goSession") + ": " + annotation.sourceSessionTitle
                          : t("goSession"),
                        onClick: function (event) { event.stopPropagation(); jumpToSession(annotation); }
                      },
                      h(Icon, { name: "chat", size: 12 })
                    )
                  : null,
                isNote
                  ? h(
                      "button",
                      {
                        type: "button",
                        className: "pr-icon-btn pr-icon-btn-sm",
                        title: t("editNoteTitle"),
                        onClick: function (event) { event.stopPropagation(); editNote(annotation); }
                      },
                      h(Icon, { name: "pencil", size: 12 })
                    )
                  : null,
                h(
                  "button",
                  {
                    type: "button",
                    className: "pr-icon-btn pr-icon-btn-sm pr-icon-btn-danger",
                    title: t("delete"),
                    onClick: function (event) { event.stopPropagation(); removeAnnotation(annotation.id); }
                  },
                  h(Icon, { name: "trash", size: 12 })
                )
              )
            );
          })
        );
      }

      function renderCodeBody() {
        var code = meta !== null && meta.code !== undefined ? meta.code : { repo: "", path: "", note: "" };
        var draft = codeDraft === null ? { repo: code.repo, path: code.path } : codeDraft;
        var children = [];
        var listing = tree !== null ? tree : null;
        var currentPath = code.path;
        children.push(h(
          "div",
          { className: "pr-code-hint" },
          code.repo === "" && currentPath === "" ? t("codeEmpty") : ""
        ));
        children.push(h(
          "label",
          { className: "pr-field" },
          h("span", null, t("codeRepo")),
          h("input", {
            className: "pr-input",
            value: draft.repo,
            placeholder: "https://github.com/owner/repo",
            onChange: function (event) { setCodeDraft({ repo: event.target.value, path: draft.path }); }
          })
        ));
        children.push(h(
          "label",
          { className: "pr-field" },
          h("span", null, t("codePath")),
          h("input", {
            className: "pr-input",
            value: draft.path,
            placeholder: "~/Projects/... or /abs/path",
            onChange: function (event) { setCodeDraft({ repo: draft.repo, path: event.target.value }); }
          })
        ));
        children.push(h(
          "div",
          { className: "pr-code-actions" },
          h("button", { type: "button", className: "pr-btn pr-btn-primary", onClick: saveCodeLink }, t("codeSave")),
          h("button", { type: "button", className: "pr-btn", onClick: askImplement }, t("codeWrite")),
          code.repo === ""
            ? h("button", { type: "button", className: "pr-btn", onClick: askForRepo }, t("aiRepo"))
            : null,
          code.repo !== ""
            ? h("a", { className: "pr-btn", href: code.repo, target: "_blank", rel: "noreferrer" }, t("codeOpenRepo"))
            : null
        ));
        if (currentPath !== "") {
          var shownPath = listing !== null ? listing.path : currentPath;
          children.push(h(
            "div",
            { className: "pr-tree-path" },
            h(
              "button",
              {
                type: "button",
                className: "pr-icon-btn",
                title: t("codeUp"),
                onClick: function () {
                  var up = shownPath.replace(/\/[^/]+\/?$/, "");
                  browseCode(up === "" ? "/" : up);
                }
              },
              h(Icon, { name: "arrowUp", size: 13 })
            ),
            h("span", { title: shownPath }, shownPath)
          ));
          if (listing !== null && listing.error !== undefined) {
            children.push(h("div", { className: "pr-code-hint" }, listing.error));
          } else if (listing !== null) {
            children.push(h(
              "div",
              { className: "pr-tree" },
              listing.entries.map(function (entry) {
                var isDir = entry.dir === true;
                return h(
                  "button",
                  {
                    key: entry.name,
                    type: "button",
                    className: "pr-tree-row",
                    onClick: function () {
                      if (isDir) browseCode(shownPath.replace(/\/+$/, "") + "/" + entry.name);
                      else askAboutFile(entry);
                    }
                  },
                  h(Icon, { name: isDir ? "folder" : "file", size: 13 }),
                  h("span", { className: "pr-tree-name" }, entry.name),
                  isDir ? null : h("span", { className: "pr-tree-size" }, formatBytes(entry.size))
                );
              })
            ));
          }
        }
        return h("div", { className: "pr-panel-body" }, children);
      }

      function renderPanel() {
        if (!notesOpen) return null;
        return h(
          "div",
          { className: "pr-panel pr-notes-panel" },
          h(
            "div",
            { className: "pr-panel-head" },
            h(
              "div",
              { className: "pr-panel-tabs" },
              h(
                "button",
                {
                  type: "button",
                  className: "pr-panel-tab" + (panelTab === "notes" ? " pr-panel-tab-on" : ""),
                  onClick: function () { setPanelTab("notes"); }
                },
                t("notesTab"),
                h("span", { className: "pr-tab-count" }, String(annotations.length))
              ),
              h(
                "button",
                {
                  type: "button",
                  className: "pr-panel-tab" + (panelTab === "code" ? " pr-panel-tab-on" : ""),
                  onClick: function () { setPanelTab("code"); }
                },
                t("codeTab")
              )
            ),
            iconButton("close", t("close"), function () { setNotesOpen(false); })
          ),
          panelTab === "code" ? renderCodeBody() : renderNoteBody()
        );
      }

      function renderSelectionPopup() {
        if (selection === null) return null;
        var width = 236;
        var left = Math.min(Math.max(selection.rect.left + selection.rect.width / 2 - width / 2, 8), Math.max(8, window.innerWidth - width - 8));
        var top = selection.rect.top - 46;
        if (top < 8) top = selection.rect.bottom + 10;
        return ReactDOM.createPortal(
          h(
            "div",
            {
              className: "pr-popup",
              style: { left: left + "px", top: top + "px", width: width + "px" },
              onMouseDown: function (event) { event.preventDefault(); }
            },
            h("button", { type: "button", onClick: addHighlight }, h(Icon, { name: "marker", size: 14 }), t("highlight")),
            h("button", { type: "button", onClick: beginNote }, h(Icon, { name: "pencil", size: 14 }), t("addNote")),
            h("button", { type: "button", onClick: askInConversation }, h(Icon, { name: "chat", size: 14 }), t("ask"))
          ),
          document.body
        );
      }

      function renderNoteEditor() {
        if (noteEditor === null) return null;
        var width = 292;
        var anchorLeft = noteEditor.rect !== null ? noteEditor.rect.left + noteEditor.rect.width / 2 : window.innerWidth / 2;
        var left = Math.min(Math.max(anchorLeft - width / 2, 8), Math.max(8, window.innerWidth - width - 8));
        var top = noteEditor.rect !== null ? noteEditor.rect.bottom + 10 : window.innerHeight / 2 - 90;
        if (top + 220 > window.innerHeight) {
          top = noteEditor.rect !== null ? Math.max(8, noteEditor.rect.top - 230) : Math.max(8, top);
        }
        return ReactDOM.createPortal(
          h(NoteEditor, {
            key: noteEditor.id === null ? "new" : noteEditor.id,
            width: width,
            left: left,
            top: top,
            title: noteEditor.id === null ? t("noteTitle") : t("editNoteTitle"),
            placeholder: t("notePlaceholder"),
            initial: noteEditor.note,
            quote: noteEditor.text,
            quoteLabel: t("quote"),
            saveLabel: t("save"),
            cancelLabel: t("cancel"),
            onCancel: function () { setNoteEditor(null); },
            onSave: saveNote
          }),
          document.body
        );
      }

      function renderMoreMenu() {
        if (!moreOpen) return null;
        var items = [];
        if (meta !== null) {
          items.push(h(
            "button",
            {
              type: "button",
              key: "fit",
              className: "pr-menu-item",
              onClick: function () { measureWidth(); setZoom(1); setMoreOpen(false); }
            },
            h(Icon, { name: "expand", size: 14 }),
            t("fitWidth")
          ));
          items.push(h(
            "button",
            {
              type: "button",
              key: "parse",
              className: "pr-menu-item" + (mineruParsed || mineruBusy ? " pr-menu-item-off" : ""),
              disabled: mineruParsed || mineruBusy,
              onClick: function () { runParse("mineru"); }
            },
            h(Icon, { name: "info", size: 14 }),
            mineruParsed ? t("parseMineruDone") : mineruBusy ? t("parseRunning") : t("parseRun")
          ));
          items.push(h(
            "a",
            {
              key: "download",
              className: "pr-menu-item",
              href: "/paper-reader/file?id=" + encodeURIComponent(docId),
              download: meta.fileName || (meta.title + ".pdf"),
              onClick: function () { setMoreOpen(false); }
            },
            h(Icon, { name: "download", size: 14 }),
            t("downloadPdf")
          ));
          items.push(h(
            "button",
            {
              type: "button",
              key: "delete",
              className: "pr-menu-item pr-menu-item-danger",
              onClick: function () {
                var needsConfirm = confirmId !== docId;
                removePaper(docId);
                if (!needsConfirm) setMoreOpen(false);
              }
            },
            h(Icon, { name: "trash", size: 14 }),
            confirmId === docId ? t("confirmDelete") : t("deletePaper")
          ));
        }
        items.push(h(
          "button",
          {
            type: "button",
            key: "settings",
            className: "pr-menu-item",
            onClick: openSettingsPage
          },
          h(Icon, { name: "gear", size: 14 }),
          t("settings")
        ));
        items.push(h(
          "button",
          {
            type: "button",
            key: "upload",
            className: "pr-menu-item",
            onClick: function () { setMoreOpen(false); chooseFile(); }
          },
          h(Icon, { name: "upload", size: 14 }),
          t("upload")
        ));
        return [
          h("div", { key: "shade", className: "pr-menu-shade", onClick: function () { setMoreOpen(false); } }),
          h("div", { key: "menu", className: "pr-menu" }, items)
        ];
      }

      function renderAtHint() {
        if (!atHint) return null;
        return h(
          "div",
          { className: "pr-at-hint" },
          h("span", { className: "pr-at-hint-caret" }),
          h("span", { className: "pr-at-hint-text" }, t("atHintText")),
          h("button", {
            type: "button",
            className: "pr-icon-btn pr-at-hint-close",
            title: t("close"),
            onClick: dismissAtHint
          }, h(Icon, { name: "close", size: 11 }))
        );
      }

      function renderParseBar() {
        if (!parsing) return null;
        return h(
          "div",
          { className: "pr-parsebar" },
          h(
            "div",
            { className: "pr-parsebar-line" },
            h("div", { className: "pr-parsebar-fill", style: { width: parsePercent + "%" } })
          ),
          h(
            "div",
            { className: "pr-parsebar-text" },
            t("parseProgress")(parse.engine, parsePercent)
          )
        );
      }

      function renderPagePill() {
        if (meta === null || pageCount === 0) return null;
        return h(
          "div",
          { className: "pr-pagepill" },
          h("button", {
            type: "button",
            className: "pr-icon-btn",
            title: t("prevPage"),
            disabled: currentPage <= 1,
            onClick: function () { goToPage(currentPage - 1); }
          }, h(Icon, { name: "chevronLeft", size: 14 })),
          h("span", { className: "pr-pagecount" }, currentPage + " / " + pageCount),
          h("button", {
            type: "button",
            className: "pr-icon-btn",
            title: t("nextPage"),
            disabled: currentPage >= pageCount,
            onClick: function () { goToPage(currentPage + 1); }
          }, h(Icon, { name: "chevronRight", size: 14 }))
        );
      }

      var body;
      if (error !== null) {
        body = renderError();
      } else if (pdf === null || pageSizes === null) {
        body = h(
          "div",
          { className: "pr-empty" },
          h("div", { className: "pr-spinner" }),
          h("div", { className: "pr-empty-desc" }, busy === "upload" ? t("uploading") : t("opening"))
        );
      } else {
        body = h(
          "div",
          {
            className: "pr-viewport",
            ref: viewportRef,
            onScroll: onScroll,
            onMouseUp: onViewportMouseUp
          },
          renderPages()
        );
      }

      var emptyState = error === null && pdf === null && busy === "" && libraryOpen === false
        ? renderEmpty()
        : null;

      return h(
        "div",
        {
          className: "pr-root",
          onDragOver: function (event) { event.preventDefault(); setDragOver(true); },
          onDragLeave: function (event) {
            if (event.currentTarget === event.target) setDragOver(false);
          },
          onDrop: onDrop
        },
        renderToolbar(),
        h(
          "div",
          { className: "pr-body", ref: bodyRef },
          emptyState !== null ? emptyState : body,
          renderLibrary(),
          renderPanel()
        ),
        renderAtHint(),
        renderParseBar(),
        renderPagePill(),
        renderMoreMenu(),
        renderSelectionPopup(),
        renderNoteEditor(),
        dragOver ? h("div", { className: "pr-drop" }, h(Icon, { name: "upload", size: 26 }), h("div", null, t("dropHere"))) : null,
        toast !== null ? h("div", { className: "pr-toast" }, toast) : null,
        h("input", {
          ref: fileInputRef,
          type: "file",
          accept: "application/pdf,.pdf",
          className: "pr-file-input",
          onChange: onFileInputChange
        })
      );
    }

    // ── crash containment + error log ────────────────────────────────────────

    var ERROR_LOG_KEY = "dsh-paper-reader:errors";

    function recordError(kind, message, stack) {
      try {
        var list = JSON.parse(window.localStorage.getItem(ERROR_LOG_KEY) || "[]");
        list.push({
          at: Date.now(),
          kind: kind,
          message: String(message === undefined ? "" : message).slice(0, 2000),
          stack: String(stack === undefined ? "" : stack).slice(0, 4000)
        });
        window.localStorage.setItem(ERROR_LOG_KEY, JSON.stringify(list.slice(-20)));
      } catch (error) {
        /* storage can be unavailable in private mode */
      }
    }

    function installErrorLog() {
      if (window.__paperReaderErrorLog === true) return;
      window.__paperReaderErrorLog = true;
      window.addEventListener("error", function (event) {
        recordError("error", event.message, event.error !== undefined && event.error !== null ? event.error.stack : "");
      });
      window.addEventListener("unhandledrejection", function (event) {
        var reason = event.reason;
        recordError("rejection", reason !== undefined && reason !== null ? reason.message || reason : "", reason !== undefined && reason !== null ? reason.stack : "");
      });
    }

    // A reader error must never take the host shell down with it.
    class ReaderBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error: error };
      }

      componentDidCatch(error, info) {
        recordError("render", error && error.message, (error && error.stack) + "\n" + (info && info.componentStack));
        if (typeof console !== "undefined" && console.error) console.error("[dsh-paper-reader] render failed:", error, info);
      }

      render() {
        if (this.state.error === null) return this.props.children;
        var message = this.state.error !== undefined && this.state.error !== null ? String(this.state.error.message || this.state.error) : "";
        return h(
          "div",
          { className: "pr-crash" },
          h("div", { className: "pr-crash-title" }, "论文阅读器出错了 / Paper reader failed"),
          h("div", { className: "pr-crash-body" }, message.slice(0, 400)),
          h(
            "button",
            {
              type: "button",
              className: "pr-btn",
              onClick: function () { this.setState({ error: null }); }.bind(this)
            },
            "重试 / Retry"
          )
        );
      }
    }

    function PaperReaderTab(props) {
      return h(ReaderBoundary, null, h(PaperReader, props));
    }

    // ── settings panel ───────────────────────────────────────────────────────

    /**
     * Settings live on the plugin's own page in the Plugins panel, so the reader
     * stays a reader. The entry renders for its own bundle subject only.
     */
    function SettingsSection(props) {
      var subject = props.subject;
      var mine = subject !== undefined && subject !== null && subject.kind === "bundle"
        && subject.pkg !== undefined && subject.pkg !== null && subject.pkg.name === "dsh-paper-reader";
      if (!mine) return null;
      return h(SettingsForm, { ctx: props.ctx });
    }

    function SettingsForm(props) {
      var ctx = props.ctx;
      var langPair = useState(langOf(ctx));
      var lang = langPair[0];
      var settingsPair = useState(null);
      var settings = settingsPair[0];
      var setSettings = settingsPair[1];
      var draftPair = useState(null);
      var draft = draftPair[0];
      var setDraft = draftPair[1];
      var savingPair = useState(false);
      var saving = savingPair[0];
      var setSaving = savingPair[1];
      var failedPair = useState(false);
      var failed = failedPair[0];
      var setFailed = failedPair[1];

      var t = function (key) { return textOf(lang, key); };

      useEffect(function () {
        var dispose = ctx.on("locale/change", function () { setLang(langOf(ctx)); });
        return typeof dispose === "function" ? dispose : function () {};
      }, [ctx]);

      useEffect(function () {
        getSettings().then(function (value) {
          if (value === null || value === undefined) return;
          setSettings(value);
          setDraft({
            workRoot: value.workRoot,
            mineruModel: value.mineruModel,
            mineruLang: value.mineruLang,
            mineruApiKey: ""
          });
        }).catch(function () { /* the form keeps its defaults */ });
      }, []);

      var current = settings === null
        ? { mineruApiKeySet: false, mineruApiKeyHint: "" }
        : settings;
      var editing = draft === null
        ? { workRoot: "", mineruModel: "vlm", mineruLang: "ch", mineruApiKey: "" }
        : draft;
      var dirty = settings !== null && draft !== null && (
        editing.workRoot !== settings.workRoot
        || editing.mineruModel !== settings.mineruModel
        || editing.mineruLang !== settings.mineruLang
        || editing.mineruApiKey.trim() !== ""
      );

      function edit(field, value) {
        setFailed(false);
        setDraft(function (previous) {
          var next = Object.assign({}, previous === null ? editing : previous);
          next[field] = value;
          return next;
        });
      }

      function save() {
        if (draft === null || saving) return;
        setSaving(true);
        setFailed(false);
        var patch = {
          workRoot: editing.workRoot.trim(),
          mineruModel: editing.mineruModel.trim(),
          mineruLang: editing.mineruLang.trim()
        };
        if (editing.mineruApiKey.trim() !== "") patch.mineruApiKey = editing.mineruApiKey.trim();
        patchSettings(patch).then(function (value) {
          setSettings(value);
          setDraft({
            workRoot: value.workRoot,
            mineruModel: value.mineruModel,
            mineruLang: value.mineruLang,
            mineruApiKey: ""
          });
          setSaving(false);
        }).catch(function () {
          setSaving(false);
          setFailed(true);
        });
      }

      var children = [];
      if (primitives !== null && typeof primitives.SettingsForm === "function") {
        children.push(h(primitives.SettingsValueField, {
          id: "paper-reader-work-root",
          label: t("workRootLabel"),
          hint: t("workRootHint"),
          text: editing.workRoot,
          overridden: false,
          overriddenLabel: "",
          resetLabel: "",
          invalid: false,
          invalidLabel: "",
          disabled: saving,
          placeholder: "~/.paper_reading",
          onEdit: function (value) { edit("workRoot", value); },
          onReset: function () {}
        }));
        children.push(h(primitives.SettingsSecretField, {
          id: "paper-reader-mineru-token",
          label: t("mineruKey"),
          hint: t("mineruHint"),
          text: editing.mineruApiKey,
          configured: current.mineruApiKeySet === true,
          stateLabel: current.mineruApiKeySet === true ? t("mineruKeySet").replace("{hint}", current.mineruApiKeyHint) : "",
          disabled: saving,
          onEdit: function (value) { edit("mineruApiKey", value); }
        }));
        children.push(h(primitives.SettingsValueField, {
          id: "paper-reader-mineru-model",
          label: t("mineruModel"),
          hint: t("mineruModelHint"),
          text: editing.mineruModel,
          overridden: false,
          overriddenLabel: "",
          resetLabel: "",
          invalid: false,
          invalidLabel: "",
          disabled: saving,
          onEdit: function (value) { edit("mineruModel", value); },
          onReset: function () {}
        }));
        children.push(h(primitives.SettingsValueField, {
          id: "paper-reader-mineru-lang",
          label: t("mineruLang"),
          hint: t("mineruLangHint"),
          text: editing.mineruLang,
          overridden: false,
          overriddenLabel: "",
          resetLabel: "",
          invalid: false,
          invalidLabel: "",
          disabled: saving,
          onEdit: function (value) { edit("mineruLang", value); },
          onReset: function () {}
        }));
        return h(primitives.SettingsForm, {
          labels: {
            unavailable: t("settingsUnavailable"),
            readOnly: t("settingsReadOnly"),
            saveFailed: t("saveFailed"),
            save: t("save"),
            saving: t("saving")
          },
          state: {
            available: true,
            writable: true,
            dirty: dirty,
            invalid: false,
            saving: saving,
            failed: failed
          },
          onSave: save,
          onDiscard: function () {},
          children: children
        });
      }

      // Fallback when the shared primitives are not on this page's module table.
      return h(
        "div",
        { className: "pr-set" },
        h("div", { className: "pr-set-hint" }, t("workRootHint")),
        h("input", {
          className: "pr-input",
          value: editing.workRoot,
          placeholder: "~/.paper_reading",
          onChange: function (event) { edit("workRoot", event.target.value); }
        }),
        h("div", { className: "pr-set-foot" },
          h("button", { type: "button", className: "pr-btn pr-btn-primary", onClick: save }, t("save"))
        )
      );
    }

    // ── note popover ─────────────────────────────────────────────────────────

    function NoteEditor(props) {
      var textareaRef = useRef(null);
      var valuePair = useState(props.initial === undefined ? "" : props.initial);
      var value = valuePair[0];
      var setValue = valuePair[1];

      useEffect(function () {
        var element = textareaRef.current;
        if (element !== null) {
          element.focus();
          var length = element.value.length;
          element.setSelectionRange(length, length);
        }
      }, []);

      return h(
        "div",
        {
          className: "pr-note-pop",
          style: { left: props.left + "px", top: props.top + "px", width: props.width + "px" },
          onMouseDown: function (event) { event.stopPropagation(); }
        },
        h("div", { className: "pr-note-pop-title" }, props.title),
        h("div", { className: "pr-quote" }, props.quote),
        h("textarea", {
          ref: textareaRef,
          className: "pr-note-input",
          placeholder: props.placeholder,
          value: value,
          onChange: function (event) { setValue(event.target.value); },
          onKeyDown: function (event) {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              props.onSave(value);
            } else if (event.key === "Escape") {
              event.preventDefault();
              props.onCancel();
            }
          }
        }),
        h(
          "div",
          { className: "pr-row" },
          h("button", { type: "button", className: "pr-btn", onClick: props.onCancel }, props.cancelLabel),
          h("button", { type: "button", className: "pr-btn pr-btn-primary", onClick: function () { props.onSave(value); } }, props.saveLabel)
        )
      );
    }

    // ── styles ───────────────────────────────────────────────────────────────

    var CSS = [
      ".pr-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family-text,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);font-size:13px;line-height:1.45}",
      ".pr-root *{box-sizing:border-box}",
      ".pr-toolbar{display:flex;align-items:center;gap:4px;padding:6px 7px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;min-width:0}",
      ".pr-title-btn{display:flex;align-items:center;gap:6px;min-width:0;flex:1 1 auto;background:none;border:0;color:inherit;padding:5px 6px;border-radius:6px;cursor:pointer;font:inherit;text-align:left}",
      ".pr-title-btn:hover{background:var(--dsw-alias-bg-layer-2)}",
      ".pr-title-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:12.5px;flex:1 1 auto;min-width:0}",
      ".pr-toolbar-actions{display:flex;align-items:center;gap:1px;flex:none}",
      ".pr-icon-btn{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;padding:0}",
      ".pr-icon-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}",
      ".pr-icon-btn:disabled{opacity:.35;cursor:default}",
      ".pr-icon-btn-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}",
      ".pr-icon-btn-danger:hover{color:var(--dsw-alias-state-error-primary)}",
      ".pr-icon-btn-confirm{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2)}",
      ".pr-zoom{display:flex;align-items:center;gap:0;margin:0 2px}",
      ".pr-zoom-level{min-width:38px;height:24px;border:0;border-radius:5px;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;padding:0 2px;font-variant-numeric:tabular-nums}",
      ".pr-zoom-level:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}",
      ".pr-body{position:relative;flex:1 1 auto;min-height:0;display:flex;overflow:hidden}",
      ".pr-viewport{flex:1 1 auto;overflow:auto;position:relative;background:var(--dsw-alias-bg-base);padding:12px 10px 58px}",
      ".pr-page{position:relative;margin:0 auto 12px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.22),0 8px 22px rgba(0,0,0,.16);overflow:hidden;border-radius:1px}",
      ".pr-canvas{display:block;position:relative;z-index:0}",
      ".pr-text-layer{position:absolute;inset:0;overflow:hidden;line-height:1;text-align:initial;text-size-adjust:none;-webkit-text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;z-index:2;opacity:1}",
      ".pr-text-layer span,.pr-text-layer br{position:absolute;color:transparent;white-space:pre;cursor:text;transform-origin:0% 0%}",
      ".pr-text-layer ::selection{background:rgba(77,107,254,.32)}",
      ".pr-hl-layer{position:absolute;inset:0;z-index:1;pointer-events:none}",
      ".pr-hl{position:absolute;border-radius:2px;transition:opacity .2s}",
      ".pr-hl-flash{animation:pr-flash 1.6s ease-out}",
      "@keyframes pr-flash{0%,40%{outline:2px solid rgba(77,107,254,.75);outline-offset:1px}100%{outline:2px solid rgba(77,107,254,0)}}",
      ".pr-at-hint{position:absolute;top:40px;right:34px;z-index:8;display:flex;align-items:center;gap:6px;max-width:230px;padding:7px 8px 7px 10px;border-radius:9px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 8px 24px rgba(0,0,0,.32)}",
      ".pr-at-hint-caret{position:absolute;top:-5px;right:12px;width:8px;height:8px;transform:rotate(45deg);background:var(--dsw-alias-bg-overlay);border-left:1px solid var(--dsw-alias-border-l1);border-top:1px solid var(--dsw-alias-border-l1)}",
      ".pr-at-hint-text{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-primary)}",
      ".pr-at-hint-close{width:16px!important;height:16px!important;margin-left:2px}",
      ".pr-parsebar{position:absolute;left:10px;right:10px;bottom:44px;z-index:7;display:flex;flex-direction:column;gap:3px;pointer-events:none}",
      ".pr-parsebar-line{height:3px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}",
      ".pr-parsebar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .4s ease}",
      ".pr-parsebar-text{font-size:10.5px;color:var(--dsw-alias-label-secondary);text-align:center}",
      ".pr-icon-btn-off,.pr-icon-btn:disabled{opacity:.38;cursor:not-allowed}",
      ".pr-pagepill{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);display:flex;align-items:center;gap:1px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:2px;box-shadow:0 6px 20px rgba(0,0,0,.28);z-index:6}",
      ".pr-pagepill .pr-icon-btn{width:24px;height:22px;border-radius:999px}",
      ".pr-pagecount{font-size:11px;color:var(--dsw-alias-label-secondary);min-width:50px;text-align:center;font-variant-numeric:tabular-nums}",
      ".pr-panel{position:absolute;inset:0;background:var(--dsw-alias-bg-layer-1);z-index:20;display:flex;flex-direction:column;min-height:0}",
      ".pr-panel-head{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}",
      ".pr-panel-title{font-weight:600;font-size:12.5px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".pr-panel-empty{padding:28px 18px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}",
      ".pr-list{flex:1 1 auto;overflow:auto;padding:10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:10px;align-content:start}",
      ".pr-doc-card{position:relative;display:flex;flex-direction:column;gap:5px;padding:6px;border-radius:10px;border:1px solid transparent;cursor:pointer;min-width:0}",
      ".pr-doc-card:hover{background:var(--dsw-alias-bg-layer-2)}",
      ".pr-doc-card-active{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}",
      ".pr-doc-thumb{position:relative;aspect-ratio:3 / 4;border-radius:7px;overflow:hidden;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;justify-content:center}",
      ".pr-doc-thumb-img{display:block;width:100%;height:100%;object-fit:contain;background:#fff}",
      ".pr-doc-thumb-ph{color:var(--dsw-alias-label-secondary)}",
      ".pr-doc-name{font-size:11.5px;font-weight:600;line-height:1.3;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}",
      ".pr-doc-meta{font-size:10px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".pr-doc-del{position:absolute;top:4px;right:4px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;cursor:pointer;opacity:0;transition:opacity .12s}",
      ".pr-doc-card:hover .pr-doc-del,.pr-doc-del-confirm{opacity:1}",
      ".pr-doc-del:hover{color:var(--dsw-alias-state-error-primary)}",
      ".pr-doc-del-confirm{width:auto;padding:0 6px;color:#fff;background:var(--dsw-alias-state-error-primary);border-color:transparent}",
      ".pr-empty{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:26px 22px;text-align:center}",
      ".pr-empty-icon{width:54px;height:54px;border-radius:15px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}",
      ".pr-empty-icon-error{color:var(--dsw-alias-state-error-primary)}",
      ".pr-empty-hint{margin-top:6px;max-width:420px;font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);text-align:center}",
      ".pr-empty-title{font-size:14px;font-weight:600}",
      ".pr-empty-desc{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);max-width:270px;word-break:break-word}",
      ".pr-spinner{width:22px;height:22px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:pr-spin .9s linear infinite}",
      "@keyframes pr-spin{to{transform:rotate(360deg)}}",
      ".pr-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:6px 11px;cursor:pointer;text-decoration:none}",
      ".pr-btn:hover{filter:brightness(1.06)}",
      ".pr-btn-small{padding:4px 8px;font-size:11px}",
      ".pr-btn:is(a){text-decoration:none}",
      ".pr-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}",
      ".pr-row{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap}",
      ".pr-spacer{flex:1 1 auto}",
      ".pr-popup{position:fixed;z-index:100001;display:flex;align-items:center;gap:1px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:3px;box-shadow:0 10px 32px rgba(0,0,0,.4)}",
      ".pr-popup button{display:inline-flex;align-items:center;justify-content:center;gap:4px;border:0;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:6px 6px;border-radius:6px;cursor:pointer;white-space:nowrap;flex:1 1 0;min-width:0}",
      ".pr-popup button:hover{background:var(--dsw-alias-bg-layer-2)}",
      ".pr-note-pop{position:fixed;z-index:100002;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:11px;padding:11px;box-shadow:0 16px 44px rgba(0,0,0,.45);display:flex;flex-direction:column;gap:8px}",
      ".pr-note-pop-title{font-size:12.5px;font-weight:600}",
      ".pr-quote{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l2);padding-left:8px;max-height:56px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;white-space:pre-wrap;word-break:break-word}",
      ".pr-note-input{width:100%;min-height:88px;resize:vertical;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.55;padding:8px;outline:none}",
      ".pr-note-input:focus{border-color:var(--dsw-alias-brand-primary)}",
      ".pr-menu-shade{position:fixed;inset:0;z-index:100000}",
      ".pr-menu{position:absolute;top:44px;right:8px;z-index:100001;min-width:176px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:4px;box-shadow:0 12px 36px rgba(0,0,0,.4);display:flex;flex-direction:column;gap:1px}",
      ".pr-menu-item-off,.pr-menu-item:disabled{opacity:.42;cursor:default}",
      ".pr-menu-item{display:flex;align-items:center;gap:7px;padding:7px 9px;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;text-decoration:none;text-align:left}",
      ".pr-menu-item:hover{background:var(--dsw-alias-bg-layer-2)}",
      ".pr-menu-item-danger{color:var(--dsw-alias-state-error-primary)}",
      ".pr-toast{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);max-width:calc(100% - 24px);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-size:11.5px;line-height:1.5;padding:7px 12px;border-radius:8px;box-shadow:0 8px 26px rgba(0,0,0,.35);z-index:7;text-align:center;pointer-events:none}",
      ".pr-drop{position:absolute;inset:8px;z-index:50;border:2px dashed var(--dsw-alias-brand-primary);border-radius:12px;background:var(--dsw-alias-bg-overlay);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--dsw-alias-label-primary);font-size:13px;pointer-events:none;opacity:.96}",
      ".pr-file-input{display:none}",
      ".pr-notes-panel{max-width:100%}",
      ".pr-note-list{display:flex;flex-direction:column;gap:1px}",
      ".pr-note-row{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:7px;cursor:pointer;min-width:0}",
      ".pr-note-row:hover{background:var(--dsw-alias-bg-layer-2)}",
      ".pr-note-row-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-primary)}",
      ".pr-note-row-actions{display:flex;align-items:center;gap:1px;flex:none;opacity:.35;transition:opacity .12s}",
      ".pr-note-row:hover .pr-note-row-actions{opacity:1}",
      ".pr-icon-btn-sm{width:20px;height:20px;border-radius:5px}",
      ".pr-note-row-body{margin-top:0;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}",
      ".pr-note-row-head{display:flex;align-items:center;gap:6px;flex-wrap:nowrap}",
      ".pr-page-chip{flex:none;white-space:nowrap;font-size:10px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
      ".pr-kind{flex:none;white-space:nowrap;display:inline-flex;align-items:center;gap:3px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}",
      ".pr-kind-note{color:var(--dsw-alias-state-success-primary)}",
      ".pr-note-row-body{margin-top:5px;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}",
      ".pr-note-row-quote{margin-top:4px;font-size:10.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}",
      ".pr-panel-tabs{display:flex;align-items:center;gap:4px;flex:1 1 auto;min-width:0}",
      ".pr-panel-tab{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;padding:4px 8px;border-radius:7px;cursor:pointer}",
      ".pr-panel-tab-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}",
      ".pr-tab-count{font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
      ".pr-author{flex:none;white-space:nowrap;font-size:10px;padding:1px 5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}",
      ".pr-author-ai{border-color:transparent;background:var(--dsw-alias-brand-primary);color:#fff}",
      ".pr-code-hint{padding:2px 2px 8px;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}",
      ".pr-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:8px;min-width:0}",
      ".pr-field-row{display:flex;gap:8px}",
      ".pr-field-row .pr-field{flex:1 1 0}",
      ".pr-input{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:6px 8px;min-width:0;width:100%;box-sizing:border-box}",
      ".pr-code-actions{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 10px}",
      ".pr-tree-path{display:flex;align-items:center;gap:6px;padding:6px 0;border-top:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-secondary);min-width:0}",
      ".pr-tree-path span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".pr-tree{display:flex;flex-direction:column;gap:1px;overflow:auto;min-height:0}",
      ".pr-tree-row{display:flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;padding:4px 6px;border-radius:6px;cursor:pointer;text-align:left}",
      ".pr-tree-row:hover{background:var(--dsw-alias-bg-layer-2)}",
      ".pr-tree-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".pr-tree-size{font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
      ".pr-panel-body{flex:1 1 auto;overflow:auto;padding:8px 10px;min-height:0}",
      ".pr-crash{padding:18px;display:flex;flex-direction:column;gap:10px;font-size:12px;color:var(--dsw-alias-label-primary)}",
      ".pr-crash-title{font-weight:600;font-size:13px}",
      ".pr-crash-body{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;word-break:break-word}",
      ".pr-set{display:flex;flex-direction:column;gap:8px;font-size:12.5px;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1);margin-top:12px}",
      ".pr-set-head{font-weight:600;font-size:13.5px}",
      ".pr-set-section{font-weight:600;font-size:12.5px;margin-top:6px}",
      ".pr-set-hint{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}",
      ".pr-set-foot{display:flex;align-items:center;gap:10px;margin-top:4px}",
      ".pr-set-note{font-size:11.5px;color:var(--dsw-alias-label-secondary)}",
      ".pr-set .pr-field{display:flex;flex-direction:column;gap:4px}",
      ".pr-set .pr-field>span{font-size:11.5px;color:var(--dsw-alias-label-secondary)}",
      ".pr-set .pr-field-row{display:flex;gap:10px;flex-wrap:wrap}",
      ".pr-set .pr-field-row .pr-field{flex:1 1 160px}"
    ].join("\n");

    // ── plugin registration ──────────────────────────────────────────────────

    var inject = ["betterSidebar", "sessions", "locale", "slots"];

    function apply(ctx) {
      installErrorLog();

      ctx.effect(function () {
        var style = document.createElement("style");
        style.setAttribute("data-dsh-paper-reader", "");
        style.textContent = CSS;
        document.head.appendChild(style);
        return function () { style.remove(); };
      });

      ctx.slots.inject("plugins.detail.section", function () {
        return ctx.slots.register(
          { name: "plugins.detail.section", id: "paper-reader-settings" },
          function (props) { return h(SettingsSection, { subject: props.subject, ctx: ctx }); }
        );
      });

      ctx.effect(function () {
        return ctx.betterSidebar.registerTab({
          id: "paper-reader",
          title: function () { return textOf(langOf(ctx), "tabTitle"); },
          description: function () { return textOf(langOf(ctx), "tabDesc"); },
          icon: function (size) { return h(Icon, { name: "book", size: size }); },
          order: 45,
          single: true,
          component: PaperReaderTab
        });
      });
    }

    module.exports = { inject: inject, apply: apply };
    return module.exports;
  }
});

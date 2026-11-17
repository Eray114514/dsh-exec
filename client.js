// dsh-exec — client half (browser).
//
// A settings page with two jobs: show whether the bridge is alive, and let the
// user change the defaults without editing YAML. Everything it writes goes to
// <DSH_HOME>/plugin-data/dsh-exec/config.json through a same-origin PUT; the
// host merges that file over the profile's cordis.patch.yml.
//
// Bundle format: window.__ModuleLoader__.load({id, factory}).

window.__ModuleLoader__.load({
  id: "dsh-exec",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const el = react.createElement;
    const useState = react.useState;
    const useEffect = react.useEffect;

    const NS = "dsh-exec";
    const STATUS_URL = "/dsh-exec/status.json";
    const CONFIG_URL = "/dsh-exec/config.json";

    /* ------------------------------------------------------------------ i18n */

    const ZH = {
      nav: "命令行执行",
      title: "DSH Exec",
      subtitle:
        "在终端、脚本或别的 agent 里一行调用这个桌面端：会话由宿主进程创建，所以会立刻出现在左侧边栏，边跑边更新。",
      ready: "已就绪",
      notReady: "未就绪",
      running: "运行中",
      totalRuns: "累计运行",
      retries: "429 重试",
      host: "宿主",
      waiting: "等待宿主插件加载",
      defaultsTitle: "默认设置",
      defaultsNote: "这里保存的值只影响本机，保存在插件数据目录，不会改 profile 的配置文件。",
      mode: "默认模式",
      modeHint: "standard / ptc / minimal / cordis —— 宿主自带的四个预设，这里都能选。",
      model: "默认模型",
      modelPlaceholder: "留空 = 沿用桌面端当前模型",
      modelHint: "留空最安全。只有确认这台机器装了该模型、且希望每次运行都可复现时才填写。",
      provider: "模型来源",
      providerPlaceholder: "留空 = 按模型自动匹配",
      effort: "思考档位",
      effortAuto: "不指定",
      enforce: "新会话强制固定为上面的模型",
      enforceHint: "开启后，若该模型在本机不存在，每次运行都会失败。默认关闭。",
      permission: "权限",
      approval: "审批",
      autoWorkspace: "自动创建工作区",
      autoWorkspaceHint: "关闭后，没有对应工作区的目录会落到「未分组」。",
      heartbeat: "心跳间隔（毫秒）",
      heartbeatHint: "429 等待期间靠它区分「在等」和「挂了」。",
      concurrency: "并发上限",
      save: "保存",
      saving: "保存中…",
      saved: "已保存，下一次运行生效。",
      reset: "恢复配置默认值",
      resetDone: "已恢复为配置文件里的默认值。",
      failed: "保存失败：{error}",
      permissionReadOnly: "只读",
      permissionWorkspaceWrite: "工作区可写",
      permissionFull: "完全访问",
      approvalAsk: "每次询问",
      approvalNever: "从不询问",
      approvalOnRequest: "按需询问",
      permissionWarn:
        "「完全访问」会让被委派的任务脱离沙箱。它是单次运行的选择（--permission danger-full-access），不建议设为默认值。",
      cliTitle: "从终端调用",
      noteTitle: "429 不是崩溃",
      note:
        "有些 provider 会在配额吃紧时返回 429，让一轮对话在宿主内部退避几十秒到几分钟。这期间会话日志几乎不动，插件按上面的心跳间隔发 progress 帧，所以调用方不会把「在等」误判成「挂了」。",
      routeMissing: "宿主半边没有挂上（路由缺失）。",
    };

    const EN = {
      nav: "Command line",
      title: "DSH Exec",
      subtitle:
        "Call this desktop host from a terminal, a script or another agent. Sessions are created inside the host process, so they show up in the sidebar immediately and update while they run.",
      ready: "Ready",
      notReady: "Not ready",
      running: "Running",
      totalRuns: "Total runs",
      retries: "429 retries",
      host: "Host",
      waiting: "waiting for the host plugin",
      defaultsTitle: "Defaults",
      defaultsNote:
        "These values apply to this machine only. They live in the plugin data directory, not in the profile config.",
      mode: "Default mode",
      modeHint: "standard / ptc / minimal / cordis — all four presets the host ships are selectable here.",
      model: "Default model",
      modelPlaceholder: "empty = keep the desktop's current model",
      modelHint:
        "Empty is the safe choice. Fill this only when the model exists on this machine and runs must be reproducible.",
      provider: "Provider",
      providerPlaceholder: "empty = resolve by model",
      effort: "Reasoning effort",
      effortAuto: "not set",
      enforce: "Pin new sessions to that model",
      enforceHint: "If the model is missing on this machine every run fails. Off by default.",
      permission: "Permission",
      approval: "Approval",
      autoWorkspace: "Auto-create workspace",
      autoWorkspaceHint: "When off, a directory without a workspace row lands in Ungrouped.",
      heartbeat: "Heartbeat (ms)",
      heartbeatHint: "This is what separates waiting out a 429 from a dead run.",
      concurrency: "Max concurrent runs",
      save: "Save",
      saving: "Saving…",
      saved: "Saved. Takes effect on the next run.",
      reset: "Restore config defaults",
      resetDone: "Restored the values from the profile config.",
      failed: "Save failed: {error}",
      permissionReadOnly: "Read-only",
      permissionWorkspaceWrite: "Workspace write",
      permissionFull: "Full access",
      approvalAsk: "Ask every time",
      approvalNever: "Never ask",
      approvalOnRequest: "Ask on request",
      permissionWarn:
        "Full access lifts the sandbox for the delegated task. It is a per-run flag (--permission danger-full-access); it is a poor default.",
      cliTitle: "From a terminal",
      noteTitle: "429 is not a crash",
      note:
        "Some providers answer 429 when quota is tight, which makes one turn back off inside the host for tens of seconds or minutes. The session log barely moves during that wait; a progress frame on the cadence above is how a caller tells waiting from dead.",
      routeMissing: "The host half is not mounted (route missing).",
    };

    const interpolate = (d, key, params) => {
      let s = d[key] != null ? d[key] : key;
      if (params) {
        for (const [k, v] of Object.entries(params)) s = String(s).split("{" + k + "}").join(String(v));
      }
      return s;
    };

    /* ------------------------------------------------------------------ http */

    async function fetchJson(url, opts) {
      const res = await fetch(url, opts);
      const ct = String(res.headers.get("content-type") || "");
      if (!ct.includes("application/json")) {
        // The host's SPA fallback answers unknown routes with index.html; that
        // means the host half is not mounted.
        const err = new Error("route-missing");
        err.routeMissing = true;
        throw err;
      }
      const json = await res.json();
      if (!res.ok) {
        const err = new Error(json && json.error ? String(json.error) : "HTTP " + res.status);
        err.status = res.status;
        throw err;
      }
      return json;
    }

    /* ------------------------------------------------------------------- css */

    if (
      typeof document !== "undefined" &&
      document.querySelector('style[data-plugin-css="dsh-exec"]') === null
    ) {
      const tag = document.createElement("style");
      tag.dataset.plugin = NS;
      tag.dataset.pluginCss = NS;
      tag.textContent =
        ".dshex{display:flex;flex-direction:column;gap:16px;min-width:0;color:var(--dsw-alias-label-primary,#e5e7eb);font-size:13px;}" +
        ".dshex-title{margin:0;font-size:15px;font-weight:600;}" +
        ".dshex-sub{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#9ca3af);font-size:12px;line-height:1.65;}" +
        ".dshex-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;}" +
        ".dshex-card{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));}" +
        ".dshex-k{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:11.5px;}" +
        ".dshex-v{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:4px;}" +
        ".dshex-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:400;}" +
        ".dshex-ok{color:#34d399;background:rgba(52,211,153,.12);}" +
        ".dshex-off{color:#f87171;background:rgba(248,113,113,.12);}" +
        ".dshex-h{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 8px;}" +
        ".dshex-h h3{margin:0;font-size:13.5px;font-weight:600;}" +
        ".dshex-note{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:11.5px;line-height:1.6;margin:2px 0 0;}" +
        ".dshex-row{display:grid;grid-template-columns:minmax(120px,190px) 1fr;gap:12px;align-items:center;padding:9px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));}" +
        ".dshex-row:first-of-type{border-top:none;}" +
        ".dshex-label{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:12px;line-height:1.5;}" +
        ".dshex-field{display:flex;flex-direction:column;gap:5px;min-width:0;}" +
        ".dshex-in,.dshex-sel{width:100%;box-sizing:border-box;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04));color:inherit;font:inherit;}" +
        ".dshex-in:focus,.dshex-sel:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4176e6);}" +
        ".dshex-check{display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;}" +
        ".dshex-hint{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:11.5px;line-height:1.55;margin-top:3px;}" +
        ".dshex-warn{color:#fbbf24;font-size:11.5px;line-height:1.6;}" +
        ".dshex-actions{display:flex;align-items:center;gap:10px;margin-top:12px;}" +
        ".dshex-btn{border-radius:8px;padding:6px 14px;font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));color:inherit;}" +
        ".dshex-btn-primary{background:var(--dsw-alias-state-business-primary,#4176e6);border-color:transparent;color:#fff;}" +
        ".dshex-btn:disabled{opacity:.55;cursor:default;}" +
        ".dshex-msg{font-size:11.5px;color:#34d399;}" +
        ".dshex-msg-bad{color:#f87171;}" +
        ".dshex-pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.85;padding:12px 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));overflow-x:auto;white-space:pre;margin:0;}";
      document.head.appendChild(tag);
    }

    /* ------------------------------------------------------------------ view */

    function card(key, value) {
      return el(
        "div",
        { className: "dshex-card" },
        el("div", { className: "dshex-k" }, key),
        el("div", { className: "dshex-v" }, value),
      );
    }

    function row(label, hint, control) {
      return el(
        "div",
        { className: "dshex-row" },
        el(
          "div",
          { className: "dshex-label" },
          label || "",
          hint ? el("div", { className: "dshex-hint" }, hint) : null,
        ),
        el("div", { className: "dshex-field" }, control),
      );
    }

    function ExecSection({ t }) {
      const [status, setStatus] = useState(undefined);
      const [error, setError] = useState("");
      const [draft, setDraft] = useState(undefined);
      const [saving, setSaving] = useState(false);
      const [msg, setMsg] = useState("");
      const [bad, setBad] = useState(false);

      const loadStatus = () => {
        fetchJson(STATUS_URL)
          .then((body) => {
            setStatus(body);
            setError("");
          })
          .catch((e) => setError(e.routeMissing ? t("routeMissing") : String(e.message || e)));
      };

      useEffect(() => {
        let alive = true;
        const tick = () => {
          if (!alive) return;
          loadStatus();
        };
        tick();
        fetchJson(CONFIG_URL)
          .then((body) => {
            if (alive) setDraft(body.config);
          })
          .catch(() => {
            /* the status payload still carries an effective config */
          });
        const timer = setInterval(tick, 5000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      const online = status !== undefined && error === "";
      const counts = (status && status.counts) || {};
      const effective = (status && status.config) || {};
      const values = draft || effective;

      const set = (key, value) => setDraft((prev) => ({ ...(prev || effective), [key]: value }));

      const save = () => {
        if (draft === undefined) return;
        setSaving(true);
        setMsg("");
        const payload = {
          defaultMode: draft.defaultMode,
          defaultModel: draft.defaultModel || "",
          defaultProvider: draft.defaultProvider || "",
          defaultEffort: draft.defaultEffort || "",
          enforceDefaults: draft.enforceDefaults === true,
          defaultPermission: draft.defaultPermission,
          defaultApproval: draft.defaultApproval,
          autoCreateWorkspace: draft.autoCreateWorkspace === true,
          heartbeatMs: Number(draft.heartbeatMs) || 15000,
          maxConcurrentRuns: Number(draft.maxConcurrentRuns) || 4,
        };
        fetchJson(CONFIG_URL, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        })
          .then((body) => {
            setDraft(body.config);
            setStatus((prev) => (prev === undefined ? prev : { ...prev, config: body.config }));
            setBad(false);
            setMsg(t("saved"));
          })
          .catch((e) => {
            setBad(true);
            setMsg(t("failed", { error: e.routeMissing ? t("routeMissing") : String(e.message || e) }));
          })
          .finally(() => setSaving(false));
      };

      const reset = () => {
        setSaving(true);
        setMsg("");
        fetchJson(CONFIG_URL, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reset: true }),
        })
          .then((body) => {
            setDraft(body.config);
            setBad(false);
            setMsg(t("resetDone"));
          })
          .catch((e) => {
            setBad(true);
            setMsg(t("failed", { error: String(e.message || e) }));
          })
          .finally(() => setSaving(false));
      };

      const permissionLabel = (p) =>
        p === "read-only"
          ? t("permissionReadOnly")
          : p === "danger-full-access"
            ? t("permissionFull")
            : t("permissionWorkspaceWrite");
      const approvalLabel = (a) =>
        a === "ask" ? t("approvalAsk") : a === "on-request" ? t("approvalOnRequest") : t("approvalNever");
      const permission = values.defaultPermission || "workspace-write";

      return el(
        "div",
        { className: "dshex" },
        el(
          "div",
          null,
          el("h2", { className: "dshex-title" }, t("title")),
          el("p", { className: "dshex-sub" }, t("subtitle")),
        ),
        el(
          "div",
          { className: "dshex-grid" },
          card(
            t("title"),
            online
              ? el("span", { className: "dshex-chip dshex-ok" }, t("ready"))
              : el("span", { className: "dshex-chip dshex-off" }, t("notReady")),
          ),
          card(t("running"), String(counts.running || 0)),
          card(t("totalRuns"), String(counts.runs || 0)),
          card(t("retries"), String(counts.retries || 0)),
        ),
        el(
          "div",
          { className: "dshex-card" },
          el("div", { className: "dshex-k" }, t("host")),
          el(
            "div",
            { style: { marginTop: "6px", lineHeight: "1.8" } },
            online
              ? "pid " + status.pid + " · port " + status.port + " · " + status.startedAt
              : error || t("waiting"),
          ),
        ),
        el(
          "div",
          { className: "dshex-card" },
          el("div", { className: "dshex-h" }, el("h3", null, t("defaultsTitle"))),
          el("p", { className: "dshex-note" }, t("defaultsNote")),
          row(
            t("mode"),
            t("modeHint"),
            el(
              "select",
              {
                className: "dshex-sel",
                value: values.defaultMode || "standard",
                onChange: (e) => set("defaultMode", e.target.value),
              },
              (values.modes || ["standard", "ptc", "minimal", "cordis"]).map((m) =>
                el("option", { key: m, value: m }, m),
              ),
            ),
          ),
          row(
            t("model"),
            t("modelHint"),
            el("input", {
              className: "dshex-in",
              type: "text",
              placeholder: t("modelPlaceholder"),
              value: values.defaultModel || "",
              onChange: (e) => set("defaultModel", e.target.value),
            }),
          ),
          row(
            t("provider"),
            null,
            el("input", {
              className: "dshex-in",
              type: "text",
              placeholder: t("providerPlaceholder"),
              value: values.defaultProvider || "",
              onChange: (e) => set("defaultProvider", e.target.value),
            }),
          ),
          row(
            t("effort"),
            null,
            el(
              "select",
              {
                className: "dshex-sel",
                value: values.defaultEffort || "",
                onChange: (e) => set("defaultEffort", e.target.value),
              },
              [
                el("option", { key: "", value: "" }, t("effortAuto")),
                ...(values.efforts || ["off", "low", "medium", "high", "xhigh"]).map((m) =>
                  el("option", { key: m, value: m }, m),
                ),
              ],
            ),
          ),
          row(
            null,
            t("enforceHint"),
            el(
              "label",
              { className: "dshex-check" },
              el("input", {
                type: "checkbox",
                checked: values.enforceDefaults === true,
                onChange: (e) => set("enforceDefaults", e.target.checked),
              }),
              t("enforce"),
            ),
          ),
          row(
            t("permission"),
            null,
            el(
              "div",
              { className: "dshex-field" },
              el(
                "select",
                {
                  className: "dshex-sel",
                  value: permission,
                  onChange: (e) => set("defaultPermission", e.target.value),
                },
                (values.permissions || ["read-only", "workspace-write", "danger-full-access"]).map((p) =>
                  el("option", { key: p, value: p }, permissionLabel(p)),
                ),
              ),
              permission === "danger-full-access" ? el("div", { className: "dshex-warn" }, t("permissionWarn")) : null,
            ),
          ),
          row(
            t("approval"),
            null,
            el(
              "select",
              {
                className: "dshex-sel",
                value: values.defaultApproval || "never",
                onChange: (e) => set("defaultApproval", e.target.value),
              },
              (values.approvals || ["ask", "never", "on-request"]).map((a) =>
                el("option", { key: a, value: a }, approvalLabel(a)),
              ),
            ),
          ),
          row(
            null,
            t("autoWorkspaceHint"),
            el(
              "label",
              { className: "dshex-check" },
              el("input", {
                type: "checkbox",
                checked: values.autoCreateWorkspace !== false,
                onChange: (e) => set("autoCreateWorkspace", e.target.checked),
              }),
              t("autoWorkspace"),
            ),
          ),
          row(
            t("heartbeat"),
            t("heartbeatHint"),
            el("input", {
              className: "dshex-in",
              type: "number",
              min: 1000,
              step: 1000,
              value: String(values.heartbeatMs || 15000),
              onChange: (e) => set("heartbeatMs", Number(e.target.value)),
            }),
          ),
          row(
            t("concurrency"),
            null,
            el("input", {
              className: "dshex-in",
              type: "number",
              min: 1,
              step: 1,
              value: String(values.maxConcurrentRuns || 4),
              onChange: (e) => set("maxConcurrentRuns", Number(e.target.value)),
            }),
          ),
          el(
            "div",
            { className: "dshex-actions" },
            el(
              "button",
              { className: "dshex-btn dshex-btn-primary", disabled: saving || draft === undefined, onClick: save },
              saving ? t("saving") : t("save"),
            ),
            el("button", { className: "dshex-btn", disabled: saving, onClick: reset }, t("reset")),
            msg ? el("span", { className: bad ? "dshex-msg dshex-msg-bad" : "dshex-msg" }, msg) : null,
          ),
        ),
        el(
          "div",
          { className: "dshex-card" },
          el("div", { className: "dshex-h" }, el("h3", null, t("cliTitle"))),
          el(
            "pre",
            { className: "dshex-pre" },
            'dshx "TASK"\n' +
              'dshx --cwd D:/repo --mode ptc "TASK"\n' +
              'dshx --session session-… "FOLLOW UP"\n' +
              'dshx --json "TASK" | jq -r \'select(.type=="final") | .text\'\n' +
              "dshx --status",
          ),
        ),
        el(
          "div",
          { className: "dshex-card" },
          el("div", { className: "dshex-h" }, el("h3", null, t("noteTitle"))),
          el("p", { className: "dshex-note" }, t("note")),
        ),
      );
    }

    /**
     * The UI language, resolved without depending on the locale service, so a
     * missing service degrades to "Chinese on a Chinese machine" instead of
     * silently rendering everything in English.
     */
    function detectChinese() {
      try {
        const html = String(document.documentElement && document.documentElement.lang || "");
        if (html) return html.toLowerCase().startsWith("zh");
      } catch {
        /* no DOM */
      }
      try {
        return String(navigator.language || "").toLowerCase().startsWith("zh");
      } catch {
        return false;
      }
    }

    function apply(ctx) {
      // The documented client API is the `locale` service (`ctx.locale`,
      // declared through exports.inject below). `ctx.get()` returns undefined
      // for a service this module was not scoped to — which is exactly how the
      // first version ended up rendering English on a Chinese host, so both
      // paths are handled and the DOM language is the last resort.
      let bound = null;
      let section = null;
      const dictate = detectChinese() ? ZH : EN;
      const t = (key, params) => (bound !== null ? bound(key, params) : interpolate(dictate, key, params));

      const attachLocale = (locale) => {
        if (locale === undefined || locale === null || bound !== null) return;
        try {
          ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), "dsh-exec: dictionaries");
          bound = locale.bind(NS);
          if (section !== null) section.locale = NS;
        } catch {
          bound = null;
        }
      };

      try {
        attachLocale(ctx.locale ?? ctx.get?.("locale"));
      } catch {
        /* not scoped yet — the inject below covers it */
      }

      ctx.inject(["slots"], (scope) => {
        section = {
          name: "settings.section",
          id: NS,
          order: 13,
          label: () => t("nav"),
        };
        if (bound !== null) section.locale = NS;
        scope.slots.inject("settings.section", () =>
          scope.slots.register(section, () => el(ExecSection, { t })),
        );
      });

      if (bound === null) {
        try {
          ctx.inject(["locale"], (scoped) => attachLocale(scoped.locale));
        } catch {
          /* a client tree without locale keeps the document-derived dictionary */
        }
      }
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  },
});

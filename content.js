(() => {
  "use strict";

  const IS_GEMINI = window.location.hostname === "gemini.google.com";
  const SITE_NAME = IS_GEMINI ? "Gemini" : "ChatGPT";
  const CHATGPT_ITEM_SELECTOR = 'a[data-sidebar-item="true"][href^="/c/"]';
  const GEMINI_ITEM_SELECTOR = [
    'gem-nav-list-item[data-test-id="conversation"]',
    'div[data-test-id="conversation"]',
    '.chat-history-list gem-nav-list-item',
    '.chat-history-list a.mat-mdc-list-item[href^="/app/"]',
    'a[href^="/app/"]',
  ].join(", ");
  const ITEM_SELECTOR = IS_GEMINI ? GEMINI_ITEM_SELECTOR : CHATGPT_ITEM_SELECTOR;
  const GEMINI_MENU_BUTTON_SELECTOR = [
    'button[data-test-id="actions-menu-button"]',
    ".conversation-actions-menu-button",
    'button[aria-label*="更多选项"]',
    'button[aria-label*="More options"]',
  ].join(", ");
  const GEMINI_DELETE_BUTTON_SELECTOR = 'button[data-test-id="delete-button"]';
  const GEMINI_CONFIRM_HOST_SELECTOR = [
    'mat-dialog-container gem-button[data-test-id="confirm-button"]',
    '.cdk-overlay-pane gem-button[data-test-id="confirm-button"]',
    'gem-button[data-test-id="confirm-button"]',
    'mat-dialog-container button[data-test-id="confirm-button"]',
    '.cdk-overlay-pane button[data-test-id="confirm-button"]',
  ].join(", ");
  const CHECKBOX_CLASS = "cgpt-bulk-checkbox";
  const SELECTED_CLASS = "cgpt-bulk-selected";
  const TOOLBAR_ID = "cgpt-bulk-toolbar";
  const API_DELAY_MS = 180;
  const GEMINI_UI_TIMEOUT_MS = 5000;
  const GEMINI_DELETE_TIMEOUT_MS = 12000;
  const REFRESH_DELAY_MS = 300;
  const WATCHDOG_DELAY_MS = 2000;

  const selectedIds = new Set();
  let observer = null;
  let isDeleting = false;
  let refreshTimer = 0;
  let watchdogTimer = 0;
  let isRefreshing = false;
  let isBatchMode = false;
  let ignoreMutations = false;

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function isVisible(element) {
    if (!element?.isConnected) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  }

  function clickElement(element) {
    const eventInit = { bubbles: true, cancelable: true, view: window };
    element.dispatchEvent(new PointerEvent("pointerdown", eventInit));
    element.dispatchEvent(new MouseEvent("mousedown", eventInit));
    element.dispatchEvent(new PointerEvent("pointerup", eventInit));
    element.dispatchEvent(new MouseEvent("mouseup", eventInit));
    element.click();
  }

  async function waitFor(getElement, timeoutMs, description) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const element = getElement();
      if (element) return element;
      await sleep(100);
    }
    throw new Error(`等待${description}超时`);
  }

  function getConversationId(item) {
    const link = item.matches?.("a[href]") ? item : item.querySelector('a[href^="/app/"]');
    const href = link?.getAttribute("href") || "";
    const match = href.match(IS_GEMINI ? /^\/app\/([^/?#]+)/ : /^\/c\/([^/?#]+)/);
    return match ? match[1] : "";
  }

  function getConversationTitle(item) {
    const title = IS_GEMINI
      ? item.querySelector(".conversation-title, [data-test-id=\"conversation-title\"], .mat-mdc-list-item-title")
      : item.querySelector('span[dir="auto"]');
    const link = item.matches?.("a") ? item : item.querySelector("a");
    return (
      title?.textContent ||
      link?.getAttribute("aria-label") ||
      item.getAttribute("aria-label") ||
      "未命名会话"
    ).trim();
  }

  function getHistoryRoot() {
    if (!IS_GEMINI) return document.querySelector("#history");
    return (
      document.querySelector(".chat-history-list") ||
      document.querySelector('mat-nav-list[gem-sidenav-list][role="navigation"]') ||
      document.querySelector('mat-nav-list[gem-sidenav-list]') ||
      document.querySelector("mat-nav-list[role=\"navigation\"]")
    );
  }

  function getItems() {
    const history = getHistoryRoot();
    if (!history) return [];
    const nodes = Array.from(history.querySelectorAll(ITEM_SELECTOR)).map((item) => {
      if (!IS_GEMINI) return item;
      return (
        item.closest('gem-nav-list-item[data-test-id="conversation"]') ||
        item.closest('[data-test-id="conversation"]') ||
        item.closest(".conversation-items-container") ||
        item
      );
    });
    return Array.from(new Set(nodes)).filter(getConversationId);
  }

  function getObserveTarget() {
    return getHistoryRoot() || document.body || document.documentElement;
  }

  function findItemById(id) {
    return getItems().find((item) => getConversationId(item) === id) || null;
  }

  function preventNavigation(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  let cachedAccessToken = null;
  let cachedDeviceId = null;

  function readStorageToken() {
    try {
      const raw = localStorage.getItem("oai/accessToken") || localStorage.getItem("accessToken");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
      return parsed.accessToken || parsed.token || parsed;
    } catch {
      return localStorage.getItem("oai/accessToken") || localStorage.getItem("accessToken") || null;
    }
  }

  function readStorageDeviceId() {
    try {
      const raw = localStorage.getItem("oai/deviceId") || localStorage.getItem("oai/did") || localStorage.getItem("deviceId");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
      return parsed.deviceId || parsed.id || parsed;
    } catch {
      return localStorage.getItem("oai/deviceId") || localStorage.getItem("oai/did") || localStorage.getItem("deviceId") || null;
    }
  }

  async function refreshAccessToken() {
    const fromStorage = readStorageToken();
    if (fromStorage) {
      cachedAccessToken = fromStorage;
      return cachedAccessToken;
    }

    try {
      const res = await fetch("/api/auth/session", {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      const data = await res.json();
      cachedAccessToken = data.accessToken || data.access_token || null;
      return cachedAccessToken;
    } catch (e) {
      console.error("[AI Chat Bulk Manager] 获取 access token 失败:", e);
      return null;
    }
  }

  async function getDeviceId() {
    if (cachedDeviceId) return cachedDeviceId;
    const fromStorage = readStorageDeviceId();
    if (fromStorage) {
      cachedDeviceId = fromStorage;
      return cachedDeviceId;
    }
    return null;
  }

  function updateItemState(item) {
    const id = getConversationId(item);
    const checked = selectedIds.has(id);
    item.classList.toggle(SELECTED_CLASS, checked);
    const checkbox = item.querySelector(`.${CHECKBOX_CLASS}`);
    if (checkbox) {
      checkbox.checked = checked;
      checkbox.setAttribute("aria-label", `${checked ? "取消选择" : "选择"} ${getConversationTitle(item)}`);
    }
  }

  function updateToolbar() {
    const toolbar = document.getElementById(TOOLBAR_ID);
    if (!toolbar) return;

    const selectedCount = selectedIds.size;
    const visibleCount = getItems().length;
    const count = toolbar.querySelector("[data-cgpt-count]");
    const deleteButton = toolbar.querySelector("[data-cgpt-delete]");
    const clearButton = toolbar.querySelector("[data-cgpt-clear]");
    const selectVisibleButton = toolbar.querySelector("[data-cgpt-select-visible]");
    const toggleButton = toolbar.querySelector("[data-cgpt-toggle]");

    if (count) count.textContent = isDeleting ? "删除中..." : `已选 ${selectedCount}`;
    if (deleteButton) deleteButton.disabled = selectedCount === 0 || isDeleting;
    if (clearButton) clearButton.disabled = selectedCount === 0 || isDeleting;
    if (selectVisibleButton) selectVisibleButton.disabled = visibleCount === 0 || isDeleting;
    if (toggleButton) toggleButton.textContent = isBatchMode ? "退出" : "管理";
  }

  function syncSelectionToDom() {
    if (!isBatchMode) return;
    getItems().forEach(updateItemState);
    updateToolbar();
  }

  function createCheckbox(item) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = CHECKBOX_CLASS;
    checkbox.title = "选择会话";

    // 只阻止冒泡到 <a> 防止跳转，不 preventDefault，让浏览器立即画出勾选动画
    checkbox.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    checkbox.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });

    // change 在浏览器完成 checkbox 视觉切换后触发，再同步状态和后台 UI
    checkbox.addEventListener("change", (event) => {
      event.stopPropagation();
      const id = getConversationId(item);
      if (!id || isDeleting) {
        // 如果正在删除，回滚状态到 selectedIds 的权威值
        setTimeout(() => updateItemState(item), 0);
        return;
      }

      if (checkbox.checked) {
        selectedIds.add(id);
      } else {
        selectedIds.delete(id);
      }

      // 立即更新本行背景色，不阻塞
      item.classList.toggle(SELECTED_CLASS, checkbox.checked);

      // 把 toolbar 和全量 DOM 同步推到下一事件循环，不卡勾选动画
      setTimeout(() => {
        updateToolbar();
      }, 0);
    });

    checkbox.addEventListener("keydown", (event) => {
      if (event.key === " " || event.key === "Enter") {
        event.stopPropagation();
      }
    });

    return checkbox;
  }

  function clearDecorations() {
    for (const item of getItems()) {
      const cb = item.querySelector(`.${CHECKBOX_CLASS}`);
      if (cb) cb.remove();
      item.classList.remove(SELECTED_CLASS, "cgpt-bulk-item");
      item.querySelector('a[href^="/app/"]')?.classList.remove("cgpt-bulk-item-link");
    }
  }

  function decorateItems() {
    if (!isBatchMode) {
      clearDecorations();
      return;
    }

    for (const item of getItems()) {
      if (item.querySelector(`.${CHECKBOX_CLASS}`)) {
        updateItemState(item);
        continue;
      }

      item.classList.add("cgpt-bulk-item");
      if (IS_GEMINI) {
        item.querySelector('a[href^="/app/"]')?.classList.add("cgpt-bulk-item-link");
      }
      item.prepend(createCheckbox(item));
      updateItemState(item);
    }
    updateToolbar();
  }

  function createToolbar() {
    let toolbar = document.getElementById(TOOLBAR_ID);
    const history = getHistoryRoot();
    if (!history?.parentElement) return;

    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.id = TOOLBAR_ID;
      toolbar.innerHTML = `
        <button type="button" data-cgpt-toggle>批量删除</button>
        <button type="button" data-cgpt-select-visible style="display:none">全选</button>
        <button type="button" data-cgpt-clear style="display:none" disabled>清空</button>
        <button type="button" class="cgpt-bulk-danger" data-cgpt-delete style="display:none" disabled>删除</button>
        <span class="cgpt-bulk-count" data-cgpt-count>已选 0</span>
      `;

      toolbar.querySelector("[data-cgpt-toggle]").addEventListener("click", toggleBatchMode);
      toolbar.querySelector("[data-cgpt-select-visible]").addEventListener("click", () => {
        if (isDeleting) return;
        getItems().forEach((item) => selectedIds.add(getConversationId(item)));
        syncSelectionToDom();
      });
      toolbar.querySelector("[data-cgpt-clear]").addEventListener("click", () => {
        if (isDeleting) return;
        selectedIds.clear();
        syncSelectionToDom();
      });
      toolbar.querySelector("[data-cgpt-delete]").addEventListener("click", deleteSelected);

      history.parentElement.insertBefore(toolbar, history);
      toolbar.dataset.site = IS_GEMINI ? "gemini" : "chatgpt";
    }

    const batchButtons = toolbar.querySelectorAll(
      '[data-cgpt-select-visible], [data-cgpt-clear], [data-cgpt-delete]'
    );
    const toggleButton = toolbar.querySelector("[data-cgpt-toggle]");

    toggleButton.textContent = isBatchMode ? "退出" : "管理";
    batchButtons.forEach((btn) => {
      btn.style.display = isBatchMode ? "" : "none";
    });

    updateToolbar();
  }

  function toggleBatchMode() {
    isBatchMode = !isBatchMode;
    if (!isBatchMode) {
      selectedIds.clear();
      clearDecorations();
    }
    createToolbar();
    if (isBatchMode) {
      decorateItems();
    }
  }

  function showToast(message, type = "") {
    let toast = document.getElementById("cgpt-bulk-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "cgpt-bulk-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.dataset.type = type;
    toast.classList.add("show");
    clearTimeout(toast._timer);
    toast._timer = window.setTimeout(() => {
      toast.classList.remove("show");
    }, 3000);
  }

  function setStatus(message, type = "") {
    // 状态信息统一走 toast，toolbar 里不再保留固定状态行
    if (message) showToast(message, type);
  }

  async function deleteConversation(id) {
    if (IS_GEMINI) {
      return deleteGeminiConversation(id);
    }

    const deviceId = await getDeviceId();
    const url = `/backend-api/conversation/${encodeURIComponent(id)}`;

    const headers = {
      accept: "*/*",
      "content-type": "application/json",
      "x-openai-target-path": url,
      "x-openai-target-route": "/backend-api/conversation/{conversation_id}",
    };

    if (cachedAccessToken) {
      headers["authorization"] = `Bearer ${cachedAccessToken}`;
    }
    if (deviceId) {
      headers["oai-device-id"] = deviceId;
    }

    let response = await fetch(url, {
      method: "PATCH",
      credentials: "include",
      headers,
      body: JSON.stringify({ is_visible: false }),
    });

    // token 失效时尝试刷新一次并重试
    if (response.status === 401 || response.status === 403) {
      const newToken = await refreshAccessToken();
      if (newToken) {
        headers["authorization"] = `Bearer ${newToken}`;
        response = await fetch(url, {
          method: "PATCH",
          credentials: "include",
          headers,
          body: JSON.stringify({ is_visible: false }),
        });
      }
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`${response.status} ${response.statusText}${text ? `: ${text.slice(0, 120)}` : ""}`);
    }
  }

  function findVisible(selector, root = document) {
    return Array.from(root.querySelectorAll(selector)).find(isVisible) || null;
  }

  function findGeminiDeleteButton() {
    const byTestId = findVisible(GEMINI_DELETE_BUTTON_SELECTOR);
    if (byTestId) return byTestId;

    const menuButtons = Array.from(
      document.querySelectorAll('.cdk-overlay-pane [role="menuitem"], .cdk-overlay-pane button, [role="menu"] button')
    ).filter(isVisible);
    return (
      menuButtons.find((button) => /^(删除|Delete)$/i.test(button.textContent.trim())) ||
      menuButtons.find((button) =>
        Boolean(button.querySelector('mat-icon[data-mat-icon-name="delete"], mat-icon[fonticon="delete"]'))
      ) ||
      null
    );
  }

  function findGeminiConfirmButton() {
    const hosts = Array.from(document.querySelectorAll(GEMINI_CONFIRM_HOST_SELECTOR)).filter(isVisible);
    if (hosts.length > 0) {
      const host = hosts[hosts.length - 1];
      return host.matches("button") ? host : host.querySelector("button") || host;
    }

    const dialogButtons = Array.from(
      document.querySelectorAll('mat-dialog-container button, [role="dialog"] button, .cdk-overlay-pane button')
    ).filter(isVisible);
    const exactMatches = dialogButtons.filter((button) => /^(删除|Delete)$/i.test(button.textContent.trim()));
    return exactMatches[exactMatches.length - 1] || null;
  }

  function dismissGeminiOverlay() {
    const cancelButtons = Array.from(
      document.querySelectorAll(
        'gem-button[data-test-id="cancel-button"], button[data-test-id="cancel-button"], ' +
          'mat-dialog-container button, [role="dialog"] button'
      )
    ).filter(isVisible);
    const cancelButton = cancelButtons.find((button) => {
      const target = button.matches("button") ? button : button.querySelector("button") || button;
      return button.matches('[data-test-id="cancel-button"]') || /^(取消|Cancel)$/i.test(target.textContent.trim());
    });
    if (cancelButton) {
      const target = cancelButton.matches("button") ? cancelButton : cancelButton.querySelector("button") || cancelButton;
      clickElement(target);
      return;
    }

    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        bubbles: true,
        cancelable: true,
      })
    );
  }

  async function deleteGeminiConversation(id) {
    const item = findItemById(id);
    if (!item) throw new Error("在侧边栏中找不到该会话");

    try {
      item.scrollIntoView({ block: "center" });
      item.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

      const menuButton = await waitFor(
        () => findVisible(GEMINI_MENU_BUTTON_SELECTOR, item),
        GEMINI_UI_TIMEOUT_MS,
        "Gemini 会话菜单"
      );
      clickElement(menuButton);

      const deleteButton = await waitFor(findGeminiDeleteButton, GEMINI_UI_TIMEOUT_MS, "Gemini 删除菜单项");
      clickElement(deleteButton);

      const confirmButton = await waitFor(findGeminiConfirmButton, GEMINI_UI_TIMEOUT_MS, "Gemini 删除确认框");
      clickElement(confirmButton);

      await waitFor(
        () => (!item.isConnected || !findItemById(id) ? true : null),
        GEMINI_DELETE_TIMEOUT_MS,
        "Gemini 删除完成"
      );
    } catch (error) {
      dismissGeminiOverlay();
      throw error;
    }
  }

  async function deleteSelected() {
    if (isDeleting || selectedIds.size === 0) return;

    if (!IS_GEMINI) {
      // ChatGPT 的接口删除需要 access token；Gemini 通过网页原生删除流程执行。
      const token = await refreshAccessToken();
      if (!token) {
        setStatus("无法获取访问令牌，请确认您已登录 ChatGPT", "error");
        return;
      }
    }

    const ids = Array.from(selectedIds);
    const titles = ids
      .slice(0, 5)
      .map((id) => getConversationTitle(findItemById(id) || document.createElement("a")))
      .join("\n");
    const more = ids.length > 5 ? `\n...以及另外 ${ids.length - 5} 个会话` : "";
    const confirmed = window.confirm(`确定删除选中的 ${ids.length} 个 ${SITE_NAME} 会话吗？\n\n${titles}${more}`);
    if (!confirmed) return;

    isDeleting = true;
    updateToolbar();
    setStatus(`开始删除 ${ids.length} 个会话`, "");

    let successCount = 0;
    const failures = [];

    for (const [index, id] of ids.entries()) {
      setStatus(`正在删除 ${index + 1}/${ids.length}`, "");
      try {
        await deleteConversation(id);
        successCount += 1;
        selectedIds.delete(id);
        if (!IS_GEMINI) {
          const item = findItemById(id);
          (item?.closest("li") || item)?.remove();
        }
      } catch (error) {
        failures.push({ id, error: error.message });
      }
      await sleep(API_DELAY_MS);
    }

    isDeleting = false;

    if (selectedIds.size === 0) {
      isBatchMode = false;
      clearDecorations();
      createToolbar();
    } else {
      syncSelectionToDom();
    }

    if (failures.length > 0) {
      console.warn("[AI Chat Bulk Manager] 删除失败：", failures);
      setStatus(`已删除 ${successCount} 个，失败 ${failures.length} 个。详情见 Console。`, "error");
      return;
    }

    setStatus(`已删除 ${successCount} 个会话`, "success");
  }

  function bootstrap() {
    refresh();
    observePage();
    watchdogTimer = window.setInterval(scheduleRefresh, WATCHDOG_DELAY_MS);
  }

  function observePage() {
    if (observer) return;

    observer = new MutationObserver((mutations) => {
      if (ignoreMutations || !isBatchMode) return;

      let shouldRefresh = false;
      for (const mutation of mutations) {
        if (mutation.type !== "childList") continue;
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.matches?.(ITEM_SELECTOR) || node.querySelector?.(ITEM_SELECTOR)) {
              shouldRefresh = true;
              break;
            }
          }
        }
        if (shouldRefresh) break;
      }

      if (shouldRefresh) {
        scheduleRefresh();
      }
    });
    observeCurrentTarget();
  }

  function scheduleRefresh() {
    if (isRefreshing || refreshTimer) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      refresh();
    }, REFRESH_DELAY_MS);
  }

  function refresh() {
    if (isRefreshing) return;

    isRefreshing = true;
    ignoreMutations = true;
    observer?.disconnect();
    try {
      createToolbar();
      if (isBatchMode) {
        decorateItems();
      }
    } finally {
      isRefreshing = false;
      window.setTimeout(() => {
        ignoreMutations = false;
      }, 100);
      if (observer) {
        observeCurrentTarget();
      }
    }
  }

  function observeCurrentTarget() {
    const target = getObserveTarget();
    if (!target) return;

    observer.observe(target, {
      childList: true,
      subtree: true,
    });
  }

  bootstrap();
})();

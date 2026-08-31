// ACP WebBridge Popup JS

document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("enabled-toggle");
  const statusText = document.getElementById("status-text");
  const tokenInput = document.getElementById("token-input");
  const portInput = document.getElementById("port-input");
  const saveTokenBtn = document.getElementById("save-token-btn");
  const handoverBtn = document.getElementById("handover-btn");
  const revokeBtn = document.getElementById("revoke-btn");
  const handoverInfo = document.getElementById("handover-info");

  function refreshState() {
    chrome.runtime.sendMessage({ type: "popup_get_state" }, (res) => {
      if (!res) return;
      const { config, connected, controlledCount, userHandoverTabId } = res;

      toggle.checked = Boolean(config.enabled);
      tokenInput.value = config.token || "";
      portInput.value = config.port || 9334;

      if (!config.enabled) {
        statusText.textContent = "غير فعّال";
        statusText.style.color = "#6c757d";
      } else if (connected) {
        statusText.textContent = `متصل (${controlledCount} تبويب مُدار)`;
        statusText.style.color = "#198754";
      } else {
        statusText.textContent = "غير متصل / جارٍ الاتصال...";
        statusText.style.color = "#dc3545";
      }

      if (userHandoverTabId) {
        chrome.tabs.get(userHandoverTabId, (tab) => {
          if (chrome.runtime.lastError || !tab) {
            handoverInfo.textContent = `مُسلّم: تبويب رقم ${userHandoverTabId}`;
          } else {
            handoverInfo.textContent = `مُسلّم: ${tab.title || tab.url || userHandoverTabId}`;
          }
        });
      } else {
        handoverInfo.textContent = "لا يوجد تبويب مُسلّم حالياً";
      }
    });
  }

  toggle.addEventListener("change", () => {
    chrome.storage.local.set({ enabled: toggle.checked }, () => {
      refreshState();
    });
  });

  saveTokenBtn.addEventListener("click", () => {
    const token = tokenInput.value.trim();
    chrome.storage.local.set({ token }, () => {
      saveTokenBtn.textContent = "تم الحفظ ✓";
      setTimeout(() => { saveTokenBtn.textContent = "حفظ"; }, 1500);
      refreshState();
    });
  });

  portInput.addEventListener("change", () => {
    const port = Number(portInput.value) || 9334;
    chrome.storage.local.set({ port }, () => {
      refreshState();
    });
  });

  handoverBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "popup_handover_current" }, () => {
      refreshState();
    });
  });

  revokeBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "popup_revoke_handover" }, () => {
      refreshState();
    });
  });

  refreshState();
  setInterval(refreshState, 2000);
});

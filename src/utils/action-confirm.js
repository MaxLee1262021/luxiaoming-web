// Local MessageBox entry points: semantic classes stay explicit at each call site.
// Element Plus retains its focus trap and original confirm/cancel promise behavior.
(function () {
  let sequence = 0;

  function open(method, messageBox, message, title, options = {}) {
    const dangerous = String(options.confirmButtonClass || "").split(/\s+/).includes("lxm-action-confirm--danger");
    if (!dangerous) return messageBox[method](message, title, options);

    const trigger = document.activeElement;
    const scopeClass = `lxm-action-confirm-scope-${++sequence}`;
    let dialog = null;
    let focusFrame = 0;
    const observer = new MutationObserver(() => {
      dialog = document.querySelector(`.${scopeClass}`);
      const cancel = dialog?.querySelector(".lxm-action-cancel");
      if (!cancel || cancel.disabled) return;
      observer.disconnect();
      focusFrame = requestAnimationFrame(() => cancel.focus({ preventScroll: true }));
    });
    observer.observe(document.body, { childList: true, subtree: true });

    let result;
    try {
      result = messageBox[method](message, title, {
        ...options,
        customClass: [options.customClass, scopeClass].filter(Boolean).join(" "),
        autofocus: false,
      });
    } catch (error) {
      observer.disconnect();
      throw error;
    }

    const settle = () => {
      observer.disconnect();
      cancelAnimationFrame(focusFrame);
      // A follow-up dialog may already be open; never steal focus from it.
      requestAnimationFrame(() => {
        const active = document.activeElement;
        const activeDialog = active?.closest?.(".el-message-box, .el-dialog, .el-drawer");
        if (activeDialog && activeDialog !== dialog) return;
        if (trigger?.isConnected && !trigger.disabled && (active === document.body || dialog?.contains(active))) {
          trigger.focus({ preventScroll: true });
        }
      });
    };
    result.then(settle, settle);
    return result;
  }

  window.LXMActionConfirm = {
    confirm: (messageBox, message, title, options) => open("confirm", messageBox, message, title, options),
    prompt: (messageBox, message, title, options) => open("prompt", messageBox, message, title, options),
  };
})();

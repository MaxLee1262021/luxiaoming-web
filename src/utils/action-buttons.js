(function () {
  "use strict";

  // Use the public ElButton loading prop; do not change click handlers or tasks.
  // Lock the existing width before Vue renders the loading icon, then restore
  // authored inline styles when loading ends. Hidden buttons need no lock.
  function install(app) {
    const widths = new WeakMap();
    const isButton = (instance) => instance.$options.name === "ElButton"
      && instance.$el && instance.$el.nodeType === 1;
    function restore(element) {
      const original = widths.get(element);
      if (!original) return;
      element.style.width = original.width;
      element.style.minWidth = original.minWidth;
      widths.delete(element);
    }
    app.mixin({
      beforeUpdate() {
        if (!isButton(this) || !this.$props.loading || widths.has(this.$el)
          || this.$el.classList.contains("is-link") || this.$el.classList.contains("is-text")) return;
        const width = this.$el.getBoundingClientRect().width;
        if (!width) return;
        widths.set(this.$el, { width: this.$el.style.width, minWidth: this.$el.style.minWidth });
        this.$el.style.width = `${width}px`;
        this.$el.style.minWidth = `${width}px`;
      },
      updated() {
        if (isButton(this) && !this.$props.loading) restore(this.$el);
      },
      beforeUnmount() {
        if (isButton(this)) restore(this.$el);
      }
    });
  }
  window.LXMActionButtons = { install };
})();

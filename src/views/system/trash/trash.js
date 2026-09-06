window.LXM_PAGES.register({
  key: "trash",
  component: "LxmPageTrash",
  group: "system",
  title: "Trash",
  description: "Soft deleted data recovery page",
  styleScope: "page-route-trash",
  setup(ctx) {
    function pageRestoreTrash(row) {
      return ctx.restoreTrash(row);
    }
    function pagePurgeTrash(row) {
      return ctx.purgeTrash(row);
    }
    function pageRestoreAllTrash() {
      return ctx.restoreAllTrash();
    }
    function pageClearTrash() {
      return ctx.clearTrash();
    }
    return { restoreTrash: pageRestoreTrash, purgeTrash: pagePurgeTrash, restoreAllTrash: pageRestoreAllTrash, clearTrash: pageClearTrash };
  }
});

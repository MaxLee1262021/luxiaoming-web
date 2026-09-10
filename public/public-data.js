// Public bootstrap data only. Authenticated server data replaces these empty
// collections after login. Keep credentials and customer records out of the
// static asset tree.
(function () {
  const empty = [];
  window.LXM_DATA = {
    cities: [],
    agents: [],
    distributors: [],
    shops: [],
    staff: [],
    spots: [],
    series: [],
    albums: [],
    samples: [],
    packages: [],
    addonServices: [],
    peripherals: [],
    videoSingles: [],
    tagLibrary: [],
    guides: [],
    stories: [],
    scans: [],
    orders: [],
    afterSales: [],
    reconciliationTransfers: [],
    financeSettings: { settlementObservationDays: 3, largeSettlementThreshold: 5000 },
    monthlyClosings: [],
    adjustmentRecords: [],
    homeConfig: {},
    siteConfig: {},
    logs: empty.slice(),
    trash: empty.slice()
  };
})();

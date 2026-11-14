(function () {
  const workbench = [['svcWorkbench','工作台概览'],['svcIntake','订单承接'],['svcFollowup','跟进与完成'],['svcComplaints','客诉与退款']];
  const commission = [['svcRules','分成配置'],['svcLedger','分成明细'],['svcStaff','客服列表'],['svcSettlements','结算管理'],['svcMine','客服端']];
  for (const [group, items] of [['客服工作台',workbench],['客服分成管理',commission]]) {
    if (!LXM_CONFIG.groups.includes(group)) LXM_CONFIG.groups.splice(2,0,group);
    for (const [index,[key,label]] of items.entries()) {
      LXM_CONFIG.routeMenuKeys.push(key);
      LXM_CONFIG.menus.push({key,label,group,navigationOrder:index});
    }
  }
  const add = (role, keys) => { if (LXM_CONFIG.roles[role]) LXM_CONFIG.roles[role].menus.push(...keys); };
  add('super',[...workbench,...commission].map(([key])=>key));
  add('service',[...workbench.map(([key])=>key),'svcMine']);
  add('finance',['svcComplaints','svcLedger','svcSettlements']);
  LXM_CONFIG.roles.service_supervisor = { name:'客服主管',home:'svcWorkbench',scope:'service_group',staffId:'',menus:[...workbench.map(([key])=>key),'svcStaff','svcLedger','svcMine'] };
})();

window.LXM_VIEWS = {
  app: `
  <div>
    <lxm-page-login v-if="!state.authed && !state.authChecking" />
    <div v-else-if="!state.authed && state.authChecking" class="auth-loading" role="status" aria-live="polite">
      <div class="auth-loading-mark">鹿</div>
      <strong>正在验证登录状态</strong>
      <span>{{ state.authNotice || '请稍候…' }}</span>
    </div>
    <div v-else class="admin-shell">
      <aside class="lxm-sidebar" :class="{collapsed:state.sidebarCollapsed, 'mobile-open':state.mobileMenuOpen}">
        <div class="lxm-brand">
          <div class="brand-mark">鹿</div>
          <div class="brand-copy"><strong>鹿小鸣旅拍</strong><span>长沙旅拍经营后台</span></div>
          <button class="sidebar-toggle" :title="state.sidebarCollapsed ? '展开菜单' : '收起菜单'" @click="state.sidebarCollapsed=!state.sidebarCollapsed">{{ state.sidebarCollapsed ? '›' : '‹' }}</button>
        </div>
        <div class="menu-search" v-show="!state.sidebarCollapsed">
          <span class="menu-search-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>
          <input id="menu-search-input" v-model="state.menuSearch" type="text" placeholder="搜索菜单功能，Ctrl+K" autocomplete="off" />
          <span class="menu-search-clear" v-if="state.menuSearch" title="清空" @click="state.menuSearch=''">×</span>
          <div class="menu-search-results" v-if="state.menuSearch.trim()">
            <button v-for="m in searchedMenus" :key="m.key" class="menu-search-item" :class="{active: state.active===m.key}" @click="goMenuFromSearch(m)">
              <span class="menu-mini" v-html="menuIcon(m.key)"></span>
              <span class="msi-copy"><strong>{{ m.label }}</strong><em>{{ m.groupLabel }}</em></span>
            </button>
            <div v-if="!searchedMenus.length" class="menu-search-empty">没有找到「{{ state.menuSearch.trim() }}」相关菜单</div>
          </div>
        </div>
        <div v-for="section in LXM_CONFIG.navSections" :key="section.key" class="menu-section" v-show="!section.hidden && section.items.some(item => roleProfile.menus.includes(item.key || item))">
          <div class="menu-group"><strong>{{ section.label }}</strong><span>{{ section.desc }}</span></div>
          <template v-if="section.key==='content'">
            <button v-if="roleProfile.menus.includes('contentOverview')" class="menu-btn menu-level-1" :class="{active:state.active==='contentOverview'}" title="内容总览" @click="switchMenu('contentOverview')"><span class="menu-mini" v-html="menuIcon('contentOverview')"></span><span class="menu-text">内容总览</span></button>
            <button v-if="roleProfile.menus.includes('miniDecor')" class="menu-btn menu-level-1" :class="{active:state.active==='miniDecor'}" title="小程序首页" @click="switchMenu('miniDecor')"><span class="menu-mini" v-html="menuIcon('miniDecor')"></span><span class="menu-text">小程序首页</span></button>
            <button v-if="roleProfile.menus.includes('miniConfig')" class="menu-btn menu-level-1" :class="{active:state.active==='miniConfig'}" title="小程序全局配置" @click="switchMenu('miniConfig')"><span class="menu-mini" v-html="menuIcon('miniConfig')"></span><span class="menu-text">小程序全局配置</span></button>
            <button v-if="['albums','videoSingles','packages','peripherals','guides'].some(k=>roleProfile.menus.includes(k))" class="content-menu-subtitle" :class="{closed:!state.contentMenuOpen.products}" @click="state.contentMenuOpen.products=!state.contentMenuOpen.products"><span class="sub-dot"></span><span>旅拍内容</span><em>{{ state.contentMenuOpen.products ? '收起' : '展开' }}</em></button>
            <div v-show="state.contentMenuOpen.products">
              <button v-if="roleProfile.menus.includes('albums')" class="menu-btn menu-level-1" :class="{active:state.active==='albums'}" title="照片留影" @click="switchMenu('albums')"><span class="menu-mini" v-html="menuIcon('albums')"></span><span class="menu-text">照片留影</span></button>
              <button v-if="roleProfile.menus.includes('videoSingles')" class="menu-btn menu-level-1" :class="{active:state.active==='videoSingles'}" title="视频摄像" @click="switchMenu('videoSingles')"><span class="menu-mini" v-html="menuIcon('videoSingles')"></span><span class="menu-text">视频摄像</span></button>
              <button v-if="roleProfile.menus.includes('packages')" class="menu-btn menu-level-1" :class="{active:state.active==='packages'}" title="旅拍套餐" @click="switchMenu('packages')"><span class="menu-mini" v-html="menuIcon('packages')"></span><span class="menu-text">旅拍套餐</span></button>
              <button v-if="roleProfile.menus.includes('peripherals')" class="menu-btn menu-level-1" :class="{active:state.active==='peripherals'}" title="影像周边" @click="switchMenu('peripherals')"><span class="menu-mini" v-html="menuIcon('peripherals')"></span><span class="menu-text">影像周边</span></button>
              <button v-if="roleProfile.menus.includes('guides')" class="menu-btn menu-level-1" :class="{active:state.active==='guides'}" title="旅拍灵感" @click="switchMenu('guides')"><span class="menu-mini" v-html="menuIcon('guides')"></span><span class="menu-text">旅拍灵感</span></button>
            </div>
            <button v-if="roleProfile.menus.includes('samples')" class="menu-btn menu-level-1" :class="{active:state.active==='samples'}" title="素材库" @click="switchMenu('samples')"><span class="menu-mini" v-html="menuIcon('samples')"></span><span class="menu-text">素材库</span></button>
            <button v-if="['spots','cities','series'].some(k=>roleProfile.menus.includes(k))" class="content-menu-subtitle" :class="{closed:!state.contentMenuOpen.assets}" @click="state.contentMenuOpen.assets=!state.contentMenuOpen.assets"><span class="sub-dot"></span><span>基础内容</span><em>{{ state.contentMenuOpen.assets ? '收起' : '展开' }}</em></button>
            <div v-show="state.contentMenuOpen.assets">
              <button v-if="roleProfile.menus.includes('spots')" class="menu-btn menu-level-1" :class="{active:state.active==='spots'}" title="打卡点" @click="switchMenu('spots')"><span class="menu-mini" v-html="menuIcon('spots')"></span><span class="menu-text">打卡点</span></button>
              <button v-if="roleProfile.menus.includes('cities')" class="menu-btn menu-level-1" :class="{active:state.active==='cities'}" title="城市" @click="switchMenu('cities')"><span class="menu-mini" v-html="menuIcon('cities')"></span><span class="menu-text">城市</span></button>
              <button v-if="roleProfile.menus.includes('series')" class="menu-btn menu-level-1" :class="{active:state.active==='series'}" title="拍摄风格" @click="switchMenu('series')"><span class="menu-mini" v-html="menuIcon('series')"></span><span class="menu-text">拍摄风格</span></button>
            </div>
          </template>
          <template v-else v-for="item in section.items" :key="item.key || item">
            <button
              v-if="roleProfile.menus.includes(item.key || item)"
              class="menu-btn"
              :class="[{active:state.active===(item.key || item)}, item.level !== undefined ? 'menu-level-' + item.level : '']"
              @click="switchMenu(item.key || item)"
            >
              <span class="menu-mini" v-html="menuIcon(item.key || item) || (item.label || (LXM_CONFIG.menus.find(m=>m.key===item)||{}).label || '?').slice(0,1)"></span><span class="menu-text">{{ item.label || (LXM_CONFIG.menus.find(m=>m.key===item)||{}).label }}</span>
            </button>
          </template>
        </div>
      </aside>
      <button v-if="state.mobileMenuOpen" class="mobile-nav-backdrop" aria-label="关闭导航" @click="state.mobileMenuOpen=false"></button>

      <main class="lxm-main">
        <header class="lxm-topbar">
          <div>
            <button class="mobile-menu-toggle" aria-label="打开导航" title="打开导航" @click="state.mobileMenuOpen=!state.mobileMenuOpen">☰</button>
            <nav class="topbar-breadcrumb" v-if="breadcrumbTrail.length">
              <span v-for="(crumb, idx) in breadcrumbTrail" :key="idx" :class="{current: idx === breadcrumbTrail.length - 1}">
                <i v-if="idx">›</i>{{ crumb }}
              </span>
            </nav>
            <h1>{{ activeMenu.label }}</h1>
            <p>{{ roleProfile.name }} · {{ LXM_SERVICE.queryOnlyNotice }}</p>
          </div>
          <div class="top-actions">
            <el-date-picker v-model="state.filters.dateRange" type="daterange" size="small" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" style="width:250px" />

            <el-select v-if="!['merchant','photo'].includes(state.role)" v-model="state.filters.shopId" clearable filterable size="small" placeholder="全商家" style="width:150px"><el-option v-for="s in scopedShops" :key="s.id" :label="s.name" :value="s.id" /></el-select>
            <el-popover placement="bottom-end" width="360" trigger="click">
              <template #reference>
                <el-badge :value="messageRows.length" :hidden="!messageRows.length">
                  <el-button size="small">消息提醒</el-button>
                </el-badge>
              </template>
              <div class="message-panel">
                <div v-if="messageRows.length" v-for="m in messageRows" :key="m.type" class="message-row" @click="handleMessage(m)">
                  <strong>{{ m.type }} · {{ m.count }}</strong>
                  <span>{{ m.text }}</span>
                </div>
                <div v-else class="empty-mini">当前范围暂无待处理提醒</div>
              </div>
            </el-popover>
            <el-select v-if="canPreviewRoles" v-model="state.previewRole" size="small" style="width:156px" @change="switchRole">
              <el-option v-for="(r,k) in LXM_CONFIG.roles" :key="k" :label="'预览：'+r.name" :value="k" />
            </el-select>
            <span class="role-pill">{{ roleProfile.name }}</span>
            <el-button v-if="can('export')" size="small" @click="openExportDialog()">导出报表</el-button>
            <span class="conn-status" :class="'conn-' + (state.serverReachable===false ? 'offline' : (state.cloudMode || 'checking'))" :title="state.serverReachable===false ? '未连接后台服务，当前仅可使用本地演示数据' : state.cloudMode==='mock' ? '已连接后台服务，但当前数据源为演示模式' : '已连接后台服务，改动会写入真实数据库'">
              <i class="dot"></i>
              <template v-if="state.cloudMode==='checking'">连接检测中…</template>
              <template v-else-if="state.serverReachable===false">未连接服务 · 本地演示</template>
              <template v-else-if="state.cloudMode==='mock'">已连接 · 演示数据</template>
              <template v-else-if="state.cloudMode==='json'">已连本地真实库</template>
              <template v-else-if="state.cloudMode==='mysql'">已连生产数据库</template>
              <template v-else>已连接服务端</template>
            </span>
            <el-dropdown trigger="click" class="user-menu">
              <span class="user-trigger">
                <i class="user-avatar">鹿</i>
                <span class="user-name">{{ state.currentAccount || roleProfile.name }}</span>
                <i class="user-caret">▾</i>
              </span>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="openChangePwd()">修改密码</el-dropdown-item>
                  <el-dropdown-item divided @click="logout()">退出登录</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </header>

        <section class="lxm-content">
          <component :is="activePageComponent" />
        </section>
      </main>

      <el-dialog v-model="state.changePwd.open" title="修改密码" width="460px" class="lxm-change-pwd" :close-on-click-modal="false" append-to-body>
        <div class="cpw-form">
          <label class="cpw-field">
            <span class="cpw-label">原密码</span>
            <el-input v-model="state.changePwd.oldPwd" type="password" show-password placeholder="请输入当前登录密码" @keyup.enter="changePassword()" />
          </label>
          <label class="cpw-field">
            <span class="cpw-label">新密码</span>
            <el-input v-model="state.changePwd.newPwd" type="password" show-password placeholder="至少 8 位，需同时包含字母和数字" @keyup.enter="changePassword()" />
            <div class="cpw-strength" v-if="state.changePwd.newPwd">
              <span class="cpw-strength-bar"><i class="cpw-strength-fill" :style="{ width: (passwordStrength(state.changePwd.newPwd).score * 25) + '%', background: passwordStrength(state.changePwd.newPwd).color }"></i></span>
              <span class="cpw-strength-label" :style="{ color: passwordStrength(state.changePwd.newPwd).color }">{{ passwordStrength(state.changePwd.newPwd).label }}</span>
              <span class="cpw-strength-tip">{{ passwordStrength(state.changePwd.newPwd).tip }}</span>
            </div>
          </label>
          <label class="cpw-field">
            <span class="cpw-label">确认新密码</span>
            <el-input v-model="state.changePwd.confirmPwd" type="password" show-password placeholder="请再次输入新密码" @keyup.enter="changePassword()" />
          </label>
        </div>
        <template #footer>
          <el-button @click="state.changePwd.open = false">取消</el-button>
          <el-button type="primary" :loading="state.changePwd.loading" @click="changePassword()">确认修改</el-button>
        </template>
      </el-dialog>
    </div>

    <el-drawer v-model="state.orderDrawer" :title="state.orderReadonly ? '订单详情' : state.orderWorkMode==='afterSale' ? '订单详情与售后处理' : state.orderWorkMode==='finance' ? '订单详情与财务审核' : '订单详情与客服处理'" :size="state.orderReadonly ? '860px' : '1280px'" class="order-drawer">
      <div v-if="state.currentOrder" class="order-workbench" :class="{'readonly-detail': state.orderReadonly}">
        <section class="order-left">
          <div class="order-head-card">
            <div>
              <div class="order-no">{{ state.currentOrder.orderNo }}</div>
              <h2>{{ state.currentOrder.customer }}</h2>
              <p>{{ orderWorkflowStatusLabel(state.currentOrder) }} · {{ state.currentOrder.appointmentAt }} · {{ state.currentOrder.timePeriod }} · 当前操作者：{{ currentOperatorName() }}</p>
            </div>
            <div class="order-head-badges"><el-button size="small" type="primary" plain @click="copyOrderWechatInfo(state.currentOrder)">复制订单信息</el-button><span class="order-status-pill" :style="{background: orderWorkflowStatusMeta(state.currentOrder).color}">{{ orderWorkflowStatusLabel(state.currentOrder) }}</span><span v-if="afterSaleBadge(state.currentOrder)" class="after-sale-badge strong">{{ afterSaleBadge(state.currentOrder) }}</span><span v-if="hasRiskBlock(state.currentOrder)" class="risk-mini-tag danger">风控冻结</span><span v-if="isFinanceLocked(state.currentOrder)" class="risk-mini-tag warning">财务锁定</span></div>
          </div>
          <div v-if="orderLockReasons(state.currentOrder).length" class="order-lock-banner">
            <strong>订单锁定提醒</strong>
            <span v-for="reason in orderLockReasons(state.currentOrder)" :key="reason">{{ reason }}</span>
          </div>

          <div class="order-section">
            <h3>客户与预约信息</h3>
            <div class="detail-grid">
              <div class="detail-item"><span>客户姓名</span><strong>{{ state.currentOrder.customer }}</strong></div>
              <div class="detail-item"><span>手机号</span><strong>{{ visiblePhone(state.currentOrder) }}</strong></div>
              <div class="detail-item"><span>微信号</span><strong>{{ visibleWechat(state.currentOrder) }}</strong></div>
              <div class="detail-item"><span>拍摄时间</span><strong>{{ state.currentOrder.appointmentAt }}</strong></div>
              <div class="detail-item"><span>拍摄时段</span><strong>{{ state.currentOrder.timePeriod || '待客服确认' }}</strong></div>
              <div class="detail-item"><span>客人可见状态</span><strong>{{ serviceCustomerStatusLabel(state.currentOrder) }}</strong></div>
            </div>
            <div class="finance-status-strip">
              <div v-for="item in orderFinanceReviews(state.currentOrder)" :key="item.id">
                <span>{{ item.type }}</span>
                <strong>{{ money(item.amount) }}</strong>
                <em :class="{approved:item.status==='已审', rejected:item.status==='已驳', pending:item.status==='待审'}">{{ item.status }}</em>
              </div>
              <div v-if="!orderFinanceReviews(state.currentOrder).length"><span>财务审核</span><strong>暂无收款或退款审核记录</strong><em>待产生</em></div>
            </div>
            <div class="note-box"><b>客人预约备注</b><p>{{ state.currentOrder.customerRemark || '暂无客人备注' }}</p></div>
          </div>

          <div class="order-section">
            <div class="section-title-row"><h3>商品与加购</h3><el-button v-if="canManageOrderAddons(state.currentOrder) && !state.orderReadonly" type="primary" plain @click="openAddonDialog">选择加购商品</el-button></div>
            <div class="product-lines">
              <div v-for="p in state.currentOrder.products" :key="p.type+p.id+p.key" @click="openProduct(p)">
                <strong>{{ productName(p) }}</strong>
                <span>{{ productTypeText(p.type || resolveProduct(p).type) }} · {{ spotName(p.spotId) }} / {{ seriesName(p.seriesId) }} / {{ albumName(p.albumId) }}</span>
                <em>{{ money(p.price || productPrice(p)) }}</em>
                <el-button v-if="canManageOrderAddons(state.currentOrder) && !state.orderReadonly && p.key" class="line-remove" size="small" type="danger" plain @click.stop="removeAddon(p)">取消加购</el-button>
              </div>
            </div>
            <div class="snapshot-card">
              <b>下单商品快照</b>
              <p>{{ state.currentOrder.packageSnapshot?.name || '订单创建时已记录商品价格快照' }}</p>
              <span>原价 {{ money(state.currentOrder.packageSnapshot?.originalPrice || 0) }} · 成交价 {{ money(state.currentOrder.packageSnapshot?.price || state.currentOrder.totalAmount) }}</span>
            </div>
          </div>

          <div class="order-section">
            <div class="section-title-row"><h3>操作时间线</h3><span class="muted">仅后台可见，按时间记录客服处理、收定金、派单、交付和收尾款</span></div>
            <div class="after-sale-status-panel">
              <template v-if="orderAfterSales(state.currentOrder).length">
                <div v-for="item in orderAfterSales(state.currentOrder)" :key="item.id" class="after-sale-status-row">
                  <div><strong>{{ item.type }}</strong><span>{{ item.reason }}</span><small>客人可见：{{ item.customerVisibleStatus || item.status }}</small></div>
                  <el-tag :type="item.status==='已完成' ? 'success' : item.status==='待超管审核' ? 'warning' : 'danger'">{{ item.status }}</el-tag>
                  <em v-if="item.refundAmount">退款 {{ money(item.refundAmount) }}</em>
                </div>
              </template>
              <div v-else class="after-sale-status-empty">暂无售后服务问题</div>
            </div>
            <div v-if="canEditCurrentOrder() && !state.orderReadonly" class="follow-quick">
              <el-button size="small" @click="addFollowLog('已电话/微信联系客人，确认拍摄日期、时间、地点和需求')">已联系客人</el-button>
              <el-button size="small" @click="addFollowLog('已微信线下收取定金，并提醒客人保留沟通记录')">收定金</el-button>
              <el-button size="small" @click="addFollowLog('客人申请改期，已更新预约时间')">改期</el-button>
              <el-button size="small" @click="addFollowLog('成片已通过微信交付客人')">交付成片</el-button>
              <el-button size="small" @click="addFollowLog('已微信线下收取尾款，订单可进入完成')">收尾款</el-button>
            </div>
            <el-input v-if="canEditCurrentOrder() && !state.orderReadonly" v-model="state.followText" type="textarea" :rows="3" placeholder="填写本次操作，例如：定金已收。/ 已安排摄影师阿南。/ 客人改期到下午。" />
            <div v-if="canEditCurrentOrder() && !state.orderReadonly" class="drawer-actions inline-actions">
              <el-button type="primary" plain @click="addFollowLog()">添加跟进记录</el-button>
            </div>
            <div class="follow-timeline">
              <div v-for="(logItem,index) in filteredOrderTimelineRows(state.currentOrder, 3)" :key="logItem.sort || index" class="timeline-row">
                <span class="timeline-index">{{ index + 1 }}</span>
                <div class="timeline-card">
                  <div class="timeline-meta">
                    <b>{{ logItem.time }}</b>
                    <em>{{ logItem.operator }}</em>
                  </div>
                  <span class="timeline-category" :data-category="logItem.category">{{ logItem.category || '记录' }}</span>
                  <strong>{{ logItem.action }}</strong>
                </div>
              </div>
              <div v-if="orderTimelineRows(state.currentOrder).length > 3" class="timeline-collapse-row">
                <span>已收拢 {{ orderTimelineRows(state.currentOrder).length - 3 }} 条更早记录</span>
                <el-button size="small" plain @click="state.timelineDialog=true">弹窗预览全部</el-button>
              </div>
            </div>
          </div>
        </section>

        <section v-if="!state.orderReadonly" class="order-right" :class="{locked:isOrderAfterSaleLocked(state.currentOrder)}">
          <div v-if="canOpenOrderForEdit(state.currentOrder) && state.orderWorkMode==='service'" class="service-workbench">
            <div class="service-workbench-header">
              <div class="title-group"><h3>客服处理</h3><span class="badge-order">{{ state.currentOrder.orderNo }}</span></div>
              <div class="header-actions">
                <el-button v-if="canTransferOrder(state.currentOrder)" size="small" plain @click="openTransferDialog(state.currentOrder)">转派/交接</el-button>
                <el-button v-if="canUseOrderExceptionTools(state.currentOrder)" size="small" type="danger" plain @click="openOrderExceptionDialog(state.currentOrder)">异常处理</el-button>
                <span class="header-status">{{ serviceFlowCurrent(state.currentOrder).label }}</span>
              </div>
            </div>
            <div class="service-workbench-body">
              <div class="service-card flow-card">
                <div class="service-card-head"><strong>订单流程</strong><span>{{ serviceFlowCurrent(state.currentOrder).note }}</span></div>
                <div v-if="state.currentOrder.status==='shooting' && !['done','delivered'].includes(state.currentOrder.customerStatus)" class="stage-operation-note">
                  <strong>拍摄中可继续处理</strong>
                  <span>可登记/确认尾款、添加跟进、提交售后；普通客服不可改派摄影师或改期，异常换人/改期由超管处理。</span>
                </div>
                <div class="status-steps flow-steps">
                  <template v-for="(step,index) in serviceFlowSteps" :key="step.key">
                    <el-tooltip :content="serviceFlowDisabledReason(step,state.currentOrder) || '可推进到该状态'" placement="top" :disabled="canSetServiceFlowStep(step,state.currentOrder)">
                      <span class="disabled-tip-wrap"><button class="step-node" :class="serviceFlowClass(index,state.currentOrder)" :disabled="!canSetServiceFlowStep(step,state.currentOrder)" @click="setServiceFlowStep(step)">
                        <span class="step-dot">{{ index + 1 }}</span>
                        <span class="step-label">{{ step.label }}</span>
                      </button></span>
                    </el-tooltip>
                    <span v-if="index < serviceFlowSteps.length - 1" class="step-line" :class="{done:index < serviceFlowIndex(state.currentOrder)}"></span>
                  </template>
                </div>
                <div class="status-meta">
                  <span><b>内部订单状态</b><em class="tag-internal">{{ serviceInternalStatusLabel(state.currentOrder) }}</em></span>
                  <span><b>客人可见状态</b><em class="tag-customer">{{ serviceCustomerStatusLabel(state.currentOrder) }}</em></span>
                  <span><b>当前提示</b><em>{{ serviceFlowCurrent(state.currentOrder).label }}</em></span>
                </div>
              </div>

              <div v-if="canUseOrderExceptionTools(state.currentOrder)" class="service-card exception-card">
                <div class="service-card-head"><strong>超管异常兜底</strong><span>用于状态异常、来源归属错误、风控误锁等情况，提交后强制留痕。</span></div>
                <div class="exception-summary">
                  <span>当前状态：{{ orderWorkflowStatusLabel(state.currentOrder) }}</span>
                  <span>来源：{{ orderSourceTypeText(state.currentOrder) }}</span>
                  <span>商家：{{ shopName(state.currentOrder.shopId) }}</span>
                  <span>分销员：{{ distributorName(state.currentOrder.distributorId) }}</span>
                </div>
                <el-button type="danger" plain @click="openOrderExceptionDialog(state.currentOrder)">打开异常处理</el-button>
              </div>

              <div class="service-card">
                <div class="service-card-head"><strong>客户与履约信息</strong><span>来源与负责人只展示，变更走专用流程</span></div>
                <div class="service-info-grid">
                  <label><span>客户姓名</span><el-input v-model="state.currentOrder.customer" :disabled="!canEditCurrentOrder()" placeholder="填写客户姓名" /></label>
                  <label><span>手机号</span><div class="contact-list"><strong>{{ visiblePhone(state.currentOrder) }}</strong><small v-for="item in (state.currentOrder.extraPhones || [])" :key="item">{{ item }}</small><div class="contact-add"><el-input v-model="state.contactDraft.phone" size="small" placeholder="新增手机号" :disabled="!canEditCurrentOrder()" /><el-button size="small" plain :disabled="!canEditCurrentOrder() || !state.contactDraft.phone" @click="addOrderContact('phone')">新增</el-button></div></div></label>
                  <label><span>微信号</span><div class="contact-list"><strong>{{ visibleWechat(state.currentOrder) }}</strong><small v-for="item in (state.currentOrder.extraWechats || [])" :key="item">{{ item }}</small><div class="contact-add"><el-input v-model="state.contactDraft.wechat" size="small" placeholder="新增微信号" :disabled="!canEditCurrentOrder()" /><el-button size="small" plain :disabled="!canEditCurrentOrder() || !state.contactDraft.wechat" @click="addOrderContact('wechat')">新增</el-button></div></div></label>
                  <label><span>订单来源</span><div class="plain-value"><strong>{{ orderSourceTypeText(state.currentOrder) }}</strong><small>{{ orderSourceName(state.currentOrder) }}</small></div></label>
                  <label><span>负责客服</span><div class="plain-value"><strong>{{ serviceOwnerName(state.currentOrder) }}</strong><small>跟当前客服账号绑定</small></div></label>
                  <label><span>摄影师</span><div class="plain-action"><div><strong>{{ photographerDisplayName(state.currentOrder.photographerId) }}</strong><small>{{ canDispatchOrder(state.currentOrder) ? '预约成功后可安排摄影师' : dispatchDisabledReason(state.currentOrder) }}</small></div><el-tooltip :content="dispatchDisabledReason(state.currentOrder)" placement="top" :disabled="canDispatchOrder(state.currentOrder)"><span class="disabled-tip-wrap"><el-button size="small" plain :disabled="!canDispatchOrder(state.currentOrder)" @click="openDispatchDialog(state.currentOrder)">安排</el-button></span></el-tooltip></div></label>
                  <label class="wide"><span>预约时间</span><div class="plain-action"><div><strong>{{ state.currentOrder.appointmentAt || '待确认' }}</strong><small>{{ state.currentOrder.timePeriod || '待客服确认' }}</small></div><el-tooltip :content="rescheduleDisabledReason(state.currentOrder)" placement="top" :disabled="canRescheduleOrder(state.currentOrder)"><span class="disabled-tip-wrap"><el-button size="small" plain :disabled="!canRescheduleOrder(state.currentOrder)" @click="openRescheduleDialog(state.currentOrder)">改期拍摄</el-button></span></el-tooltip></div></label>
                </div>
              </div>

              <div class="service-card">
                <div class="service-card-head"><strong>金额核对</strong><span>客服登记，财务审核后入账</span></div>
                <div class="amount-check-card compact">
                  <div class="amount-row"><span class="amount-label">订单总价<small>原始订单金额，不可修改</small></span><span class="amount-value total">{{ money(state.currentOrder.totalAmount) }}</span></div>
                  <div class="amount-row"><span class="amount-label">优惠券减免<small>客人有优惠时添加</small></span><span class="amount-action-value"><span v-if="state.currentOrder.finalDiscountAmount" class="coupon-tag">优惠 -{{ money(state.currentOrder.finalDiscountAmount) }}</span><span v-else class="amount-tag none">未添加</span><el-button size="small" plain :disabled="!!state.moneyEdit || !canEditCurrentOrder() || ['待审','已审','待审核','已审核'].includes(state.currentOrder.finalFinanceStatus)" @click="enableMoneyEdit('couponAmount')">添加优惠券</el-button></span></div>
                  <div v-if="state.moneyEdit==='couponAmount'" class="coupon-editor amount-editor"><label>优惠金额</label><el-input-number v-model="state.moneyDraft" :min="0" :max="Math.max(Number(state.currentOrder.totalAmount || 0) - Number(state.currentOrder.depositPaid || 0), 0)" /><label>优惠原因</label><el-input v-model="state.currentOrder.priceAdjustReason" type="textarea" :rows="2" :disabled="!canEditCurrentOrder()" placeholder="请填写优惠原因，如：新客首单优惠" /><div class="edit-actions"><el-button size="small" @click="cancelMoneyEdit">取消</el-button><el-button size="small" type="primary" @click="confirmMoneyEdit('couponAmount')">确认添加</el-button></div></div>
                  <div class="amount-row"><span class="amount-label">已收定金<small>{{ normalizeReviewStatus(state.currentOrder.depositFinanceStatus)==='已审' ? '财务已核对到账' : normalizeReviewStatus(state.currentOrder.depositFinanceStatus)==='待审' ? '已提交财务核对' : normalizeReviewStatus(state.currentOrder.depositFinanceStatus)==='已驳' ? '财务已驳回，请重新核对' : '客服登记，确认后锁定' }}</small></span><span class="amount-action-value deposit-action" :title="depositPaymentDisabledReason(state.currentOrder)"><span v-if="['待审','已审','已驳'].includes(normalizeReviewStatus(state.currentOrder.depositFinanceStatus))" :class="['amount-tag', normalizeReviewStatus(state.currentOrder.depositFinanceStatus)==='已审' ? 'done' : normalizeReviewStatus(state.currentOrder.depositFinanceStatus)==='已驳' ? 'rejected' : 'pending']">{{ normalizeReviewStatus(state.currentOrder.depositFinanceStatus) }}</span><el-input-number v-model="state.currentOrder.depositPaid" :min="0" :disabled="!canRegisterDepositPayment(state.currentOrder)" /><el-button size="small" type="primary" plain :disabled="!canRegisterDepositPayment(state.currentOrder) || !state.currentOrder.depositPaid" @click="confirmPaymentRegistration('depositPaid')">确认</el-button></span></div>
                  <div class="amount-row"><span class="amount-label">应收尾款<small>= 订单总价 - 优惠 - 定金</small></span><span class="amount-action-value"><span class="amount-value">{{ money(expectedFinalAmount(state.currentOrder)) }}</span><el-tooltip :content="finalPaymentDisabledReason(state.currentOrder)" placement="top" :disabled="canConfirmFinalPayment(state.currentOrder)"><span class="disabled-tip-wrap"><el-button size="small" type="primary" plain :disabled="!canConfirmFinalPayment(state.currentOrder)" @click="confirmFinalPaymentWithCheck">确认尾款</el-button></span></el-tooltip></span></div>
                  <div class="amount-row"><span class="amount-label">财务待审核入账<small>客服已登记、财务未审核</small></span><span class="amount-value finance">{{ money(financePendingAmount(state.currentOrder)) }}</span></div>
                </div>
                <div v-if="!isDepositRegistrationConfirmed(state.currentOrder)" class="amount-alert warn"><span>!</span><p><b>请先完成定金登记</b>定金登记后即可确认尾款；财务审核通过后才会进入月度对账。</p></div>
                <div v-else-if="finalGap(state.currentOrder)>0" class="amount-alert warn"><span>!</span><p><b>尾款未收齐</b>若客人享受优惠，请先添加优惠券。</p></div>
                <div v-else class="amount-alert success"><span>✓</span><p><b>客服收款口径已对平</b>{{ state.currentOrder.finalDiscountAmount ? '已记录优惠券减免，等待财务复核。' : '定金与尾款已覆盖订单应收金额。' }}</p></div>
              </div>

              <div class="service-card">
                <div class="service-card-head"><strong>内部备注</strong><span>仅后台可见</span></div>
                <div class="note-area"><el-input v-model="state.currentOrder.internalNote" type="textarea" :rows="3" :disabled="!canEditCurrentOrder()" placeholder="内部备注，仅后台可见，不同步给客人" /></div>
              </div>

              <div class="bottom-actions">
                <el-button type="primary" :loading="state.saving" :disabled="!canEditCurrentOrder() || state.currentOrder.status==='completed'" @click="saveOrder">{{ state.currentOrder.status==='shooting' ? '保存履约备注' : '确认客户信息' }}</el-button>
                <el-tooltip v-if="canEditCurrentOrder()" :content="isOrderAfterSaleLocked(state.currentOrder) ? '售后处理中，请先完成当前售后工单' : '发起新的售后工单'" placement="top" :disabled="!isOrderAfterSaleLocked(state.currentOrder)"><span class="disabled-tip-wrap"><el-button type="warning" plain :disabled="isOrderAfterSaleLocked(state.currentOrder)" @click="openAfterSaleSubmit()">提交售后</el-button></span></el-tooltip>
                <el-tooltip :content="completeDisabledReason(state.currentOrder)" placement="top" :disabled="canEditCurrentOrder() && state.currentOrder.status!=='completed' && canCompleteOrderPayment(state.currentOrder)"><span class="disabled-tip-wrap"><el-button type="success" plain :disabled="!canEditCurrentOrder() || state.currentOrder.status==='completed' || !canCompleteOrderPayment(state.currentOrder)" @click="openCompleteOrderDialog(state.currentOrder)">订单完成</el-button></span></el-tooltip>
                <el-tooltip v-if="can('cancelOrder')" :content="cancelDisabledReason(state.currentOrder)" placement="top" :disabled="canEditCurrentOrder() && state.currentOrder.status!=='completed' && !isOrderAfterSaleLocked(state.currentOrder)"><span class="disabled-tip-wrap"><el-button type="danger" plain :disabled="!canEditCurrentOrder() || state.currentOrder.status==='completed' || isOrderAfterSaleLocked(state.currentOrder)" @click="cancelOrder(state.currentOrder)">订单取消</el-button></span></el-tooltip>
              </div>
            </div>
          </div>
          <div v-if="state.orderWorkMode==='afterSale' && state.currentAfterSale" class="order-section sticky-service after-sale-workbench">
            <div class="after-sale-workbench-head">
              <div class="after-sale-head-left">
                <span class="after-sale-icon">售</span>
                <div><h3>售后处理</h3><p>保存记录只留痕；处理完成后工单锁定，不能再修改说明或退款金额。</p></div>
              </div>
              <div class="after-sale-head-status">
                <span>处理状态</span>
                <el-tag :type="normalizeAfterSaleStatus(state.currentAfterSale.status)==='待处理' ? 'warning' : normalizeAfterSaleStatus(state.currentAfterSale.status)==='已完成' ? 'success' : 'danger'">{{ normalizeAfterSaleStatus(state.currentAfterSale.status) }}</el-tag>
              </div>
            </div>
            <div class="after-sale-summary-grid">
              <div><span>售后类型</span><strong>{{ state.currentAfterSale.type }}</strong></div>
              <div><span>负责客服</span><strong>{{ staffName(state.currentAfterSale.assigneeId) }}</strong></div>
              <div><span>提交时间</span><strong>{{ state.currentAfterSale.createdAt }}</strong></div>
              <div><span>客人可见</span><strong>{{ state.currentAfterSale.customerVisibleStatus || normalizeAfterSaleStatus(state.currentAfterSale.status) }}</strong></div>
              <div class="full"><span>售后原因</span><p>{{ state.currentAfterSale.reason }}</p></div>
            </div>
            <div class="after-sale-process-layout">
              <div class="after-sale-process-main">
                <div class="textarea-wrap">
                  <div class="process-field-head"><label>跟进说明</label><span>必填</span></div>
                  <el-input v-model="state.afterSaleProcessForm.note" type="textarea" :rows="6" :disabled="isAfterSaleProcessReadonly(state.currentAfterSale)" placeholder="请输入本次处理记录，例如：已与客人协商一致，改期至7月5日下午。" />
                </div>
                <div class="after-sale-process-footer">
                  <div class="refund-input-wrap">
                    <label>退款金额</label>
                    <div class="refund-confirm-row">
                      <el-input-number v-model="state.afterSaleProcessForm.refundAmount" :min="0" :controls="false" :disabled="isAfterSaleProcessReadonly(state.currentAfterSale) || state.afterSaleProcessForm.refundConfirmed" />
                      <el-button size="small" type="primary" plain :disabled="isAfterSaleProcessReadonly(state.currentAfterSale) || Number(state.afterSaleProcessForm.refundAmount || 0) <= 0 || state.afterSaleProcessForm.refundConfirmed" @click="confirmAfterSaleRefundAmount">{{ state.afterSaleProcessForm.refundConfirmed ? '已确认' : '确认金额' }}</el-button>
                    </div>
                    <span class="form-tip">无退款可不填；有退款时请先确认金额，处理完成后进入财务审核。</span>
                  </div>
                  <div class="action-buttons">
                    <el-button :disabled="isAfterSaleProcessReadonly(state.currentAfterSale)" @click="saveAfterSaleProcess(false)">保存记录</el-button>
                    <el-button type="success" :disabled="isAfterSaleProcessReadonly(state.currentAfterSale) || (Number(state.afterSaleProcessForm.refundAmount || 0) > 0 && !state.afterSaleProcessForm.refundConfirmed)" @click="saveAfterSaleProcess(true)">处理完成</el-button>
                  </div>
                </div>
              </div>
              <aside class="after-sale-process-side">
                <div class="after-sale-rule"><b>售后处理规则</b><p>保存记录只记录本次进度，不结束售后；退款金额必须先确认再处理完成。处理完成后工单锁定，无退款直接结案，有退款进入财务审核。</p></div>
                <div v-if="state.currentAfterSale.logs && state.currentAfterSale.logs.length" class="after-sale-mini-logs">
                  <strong>最近处理记录</strong>
                  <span v-for="log in state.currentAfterSale.logs.slice(0,3)" :key="log">{{ log }}</span>
                </div>
                <div v-else class="after-sale-mini-logs empty">
                  <strong>最近处理记录</strong>
                  <span>暂无跟进记录，保存后会显示在这里。</span>
                </div>
              </aside>
            </div>
            <div class="after-sale-status-strip">
              <div>
                <span>退款去向</span>
                <strong>{{ Number(state.afterSaleProcessForm.refundAmount || 0) > 0 ? '提交财务审核' : '无需财务审核' }}</strong>
              </div>
              <div>
                <span>结案影响</span>
                <strong>{{ Number(state.afterSaleProcessForm.refundAmount || 0) > 0 ? '财务审核后解锁订单' : '立即进入售后记录' }}</strong>
              </div>
            </div>
          </div>
          <div v-if="state.orderWorkMode==='finance' && state.currentFinanceReview" class="order-section sticky-service after-sale-workbench">
            <div class="finance-audit-card">
              <div class="finance-audit-head">
                <div><h3>财务审核</h3><span>订单 {{ state.currentOrder.orderNo }}</span></div>
                <b>{{ money(state.currentOrder.totalAmount) }}</b>
              </div>
              <div class="finance-audit-list">
                <div v-for="(item,index) in state.currentFinanceReview.items" :key="item.id" class="finance-audit-item">
                  <div class="audit-title-row">
                    <span class="audit-num">{{ index + 1 }}</span>
                    <div><strong>{{ item.type }}</strong><em>{{ item.note || '等待财务核对微信线下收款记录' }}</em></div>
                  </div>
                  <div class="audit-row" :class="{pending:item.status==='待审', done:item.status==='已审', rejected:item.status==='已驳'}">
                    <strong>{{ money(item.amount) }}</strong>
                    <span :class="{pending:item.status==='待审', done:item.status==='已审', rejected:item.status==='已驳'}">{{ item.status }}</span>
                  </div>
                  <div class="audit-meta-row">
                    <span>提交时间：{{ item.createdAt || '-' }}</span>
                    <span v-if="item.reviewedBy">审核人：{{ item.reviewedBy }}</span>
                    <span v-if="item.reviewedAt">审核时间：{{ item.reviewedAt }}</span>
                  </div>
                  <div class="audit-actions">
                    <el-button size="small" type="primary" :disabled="item.status==='已审' || !can('financeReview')" @click="reviewFinanceItem(item,true)">审核通过</el-button>
                    <el-button size="small" type="danger" plain :disabled="item.status==='已驳' || !can('financeReview')" @click="reviewFinanceItem(item,false)">驳回</el-button>
                  </div>
                </div>
              </div>
              <div class="finance-audit-summary">
                <div><span>本单提交审核</span><strong>{{ money(state.currentFinanceReview.items.reduce((s,item)=>s+Number(item.amount||0),0)) }}</strong></div>
                <div><span>已审核入账</span><strong class="done">{{ money(state.currentFinanceReview.items.filter(item=>item.status==='已审').reduce((s,item)=>s+Number(item.amount||0),0)) }}</strong></div>
                <div><span>待审核金额</span><strong class="pending">{{ money(state.currentFinanceReview.items.filter(item=>item.status==='待审').reduce((s,item)=>s+Number(item.amount||0),0)) }}</strong></div>
              </div>
              <div class="note-box warning"><b>金额口径说明</b><p>财务只核对到账与金额是否正确；未审核通过的金额不会进入月度对账和分成。已通过不可再驳回，已驳回不可再通过。</p></div>
            </div>
          </div>
        </section>
      </div>
    </el-drawer>

    <el-dialog :close-on-click-modal="false" v-model="state.afterSaleSubmitDialog" title="提交售后" width="620px">
      <div class="form-grid single">
        <el-form-item label="售后类型"><el-select v-model="state.afterSaleForm.type"><el-option label="退款申请" value="退款申请" /><el-option label="协商退款" value="协商退款" /><el-option label="改期" value="改期" /><el-option label="投诉反馈" value="投诉反馈" /><el-option label="补发成片" value="补发成片" /><el-option label="补拍" value="补拍" /><el-option label="其他问题" value="其他问题" /></el-select></el-form-item>
        <el-form-item v-if="state.afterSaleForm.type.includes('退款')" label="申请退款金额"><el-input-number v-model="state.afterSaleForm.refundAmount" :min="0" /></el-form-item>
        <el-form-item label="售后原因"><el-input v-model="state.afterSaleForm.reason" type="textarea" :rows="4" placeholder="填写客人诉求、沟通情况、是否涉及退款或改期。" /></el-form-item>
      </div>
      <div class="note-box"><b>处理规则</b><p>客服或客人在前端提交后，订单都会进入后台售后服务；无退款可不填金额，有退款金额的售后完成后进入财务审核，并同步影响经营看板、各角色数据与月度对账。</p></div>
      <template #footer><el-button @click="state.afterSaleSubmitDialog=false">取消</el-button><el-button type="primary" @click="submitAfterSale">确定提交</el-button></template>
    </el-dialog>

    <el-dialog :close-on-click-modal="false" v-model="state.completeOrderDialog" title="订单完成核对" width="620px">
      <div v-if="state.currentOrder" class="complete-check">
        <div class="note-box warning"><b>完成前核对</b><p>订单完成前请确认成片已交付，且客服已登记定金、尾款并对平订单应收金额；未审核通过的金额可以完成履约，但不会进入月度对账和分成。</p></div>
        <div class="detail-grid compact">
          <div class="detail-item"><span>订单号</span><strong>{{ state.currentOrder.orderNo }}</strong></div>
          <div class="detail-item"><span>客户</span><strong>{{ state.currentOrder.customer }}</strong></div>
          <div class="detail-item"><span>订单总价</span><strong>{{ money(state.currentOrder.totalAmount) }}</strong></div>
          <div class="detail-item"><span>客服登记定金</span><strong>{{ money(state.currentOrder.depositPaid) }}</strong></div>
          <div class="detail-item"><span>客服登记尾款</span><strong>{{ money(state.currentOrder.finalPaid) }}</strong></div>
          <div class="detail-item"><span>应收尾款</span><strong>{{ money(expectedFinalAmount(state.currentOrder)) }}</strong></div>
          <div class="detail-item"><span>尾款差额</span><strong :class="{danger:finalGap(state.currentOrder)>0}">{{ money(finalGap(state.currentOrder)) }}</strong></div>
          <div class="detail-item"><span>财务待审核入账</span><strong :class="{danger:financePendingAmount(state.currentOrder)>0}">{{ money(financePendingAmount(state.currentOrder)) }}</strong></div>
        </div>
        <div v-if="state.currentOrder && financeDue(state.currentOrder)>0" class="note-box warning"><b>对账提醒</b><p>当前还有金额未通过财务审核；订单可先完成履约，但该金额暂不进入月度对账，需财务审核通过后统计入账。</p></div>
        <el-input v-model="state.completeOrderNote" type="textarea" :rows="3" placeholder="填写尾款核对备注，例如：客服已登记尾款，成片已发送给客人，待财务复核到账。" />
      </div>
      <template #footer>
        <el-button @click="state.completeOrderDialog=false">取消</el-button>
        <el-button type="primary" :disabled="!canCompleteOrderPayment(state.currentOrder)" @click="confirmCompleteOrder">确认订单完成</el-button>
      </template>
    </el-dialog>

    <el-dialog :close-on-click-modal="false" v-model="state.addonDialog" title="订单加购商品" width="1120px">
      <div class="addon-dialog-layout">
        <aside class="addon-filter-side">
          <div class="addon-filter-title"><strong>加购类型</strong><span>仅用于客服订单内部加购</span></div>
          <button v-for="item in filteredAddons" :key="item.key" :class="{active:state.selectedAddonKeys.includes(item.key)}" @click="toggleAddon(item)">
            <strong>{{ item.name }}</strong><small>{{ productTypeText(item.type) }} ? {{ money(item.price) }}</small>
          </button>
        </aside>
        <section class="addon-list">
          <div class="addon-list-head"><div><h3>{{ addonScopeTitle() }}</h3><p>已选择 {{ state.selectedAddonKeys.length }} 项，点击卡片选择；点击查看详情可核对套餐、照片单品或增值服务内容。</p></div></div>
          <div v-if="filteredAddons.length" class="addon-grid">
            <div v-for="item in filteredAddons" :key="item.key" class="addon-card" :class="{selected:state.selectedAddonKeys.includes(item.key)}" @click="toggleAddon(item)">
              <img :src="item.cover || item.images?.[0]" @dblclick.stop="zoomImage(item.cover || item.images?.[0])" />
              <strong>{{ item.name }}</strong>
              <span>{{ productTypeText(item.type) }} ? {{ money(item.price) }}</span>
              <small v-if="item.type==='album'">照片单品内样片可在详情中双击放大</small>
              <small v-else-if="item.type==='package'">套餐详情按小程序套餐页口径展示</small>
              <el-button link @click.stop="openProduct(item)">查看详情</el-button>
            </div>
          </div>
          <div v-else class="empty addon-empty">当前目录暂无可加购商品，可到「内容与商品」模块维护。</div>
        </section>
      </div>
      <template #footer><el-button @click="state.addonDialog=false">取消</el-button><el-button type="primary" @click="confirmAddon">确认加购 {{ state.selectedAddonKeys.length }} 项</el-button></template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.productDialog" title="商品详情" width="860px">
      <div v-if="state.currentProduct" class="product-detail"><img class="detail-cover" :src="state.currentProduct.cover || state.currentProduct.images?.[0]" /><h2>{{ state.currentProduct.name }}</h2><p>{{ state.currentProduct.intro }}</p><div class="tag-row"><el-tag v-for="t in state.currentProduct.tags || state.currentProduct.serviceTags || []" :key="t">{{ t }}</el-tag></div><div class="detail-grid"><div class="detail-item"><span>打卡点</span><strong>{{ spotName(state.currentProduct.spotId) }}</strong></div><div class="detail-item"><span>拍摄风格</span><strong>{{ seriesName(state.currentProduct.seriesId) }}</strong></div><div class="detail-item"><span>照片单品</span><strong>{{ albumName(state.currentProduct.albumId) }}</strong></div><div class="detail-item"><span>价格</span><strong>{{ money(state.currentProduct.specialPrice || state.currentProduct.price) }}</strong></div></div><div class="sample-grid"><img v-for="img in state.currentProduct.images || []" :key="img" :src="img" @dblclick="zoomImage(img)" /></div></div>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.rankPreviewDialog" title="排行数据预览" width="860px">
      <div v-if="state.rankPreview" class="rank-preview">
        <div class="rank-preview-head"><div><h2>{{ state.rankPreview.name }}</h2><p>{{ state.rankPreview.subtitle }}</p></div><el-tag>??</el-tag></div>
        <div class="content-kpis rank-preview-kpis"><div><span>扫码量</span><strong>{{ state.rankPreview.scans }}</strong></div><div><span>订单数</span><strong>{{ state.rankPreview.orders }}</strong></div><div><span>成交额</span><strong>{{ money(state.rankPreview.amount) }}</strong></div></div>
        <el-table :data="state.rankPreview.rows" height="320" stripe empty-text="暂无关联订单" @row-click="(row)=>openOrder(row,{readonly:true})"><el-table-column label="订单号" width="140"><template #default="{row}"><button class="table-link" @click.stop="openOrder(row,{readonly:true})">{{ row.orderNo }}</button></template></el-table-column><el-table-column prop="customer" label="客户" width="110" /><el-table-column label="商家"><template #default="{row}">{{ shopName(row.shopId) }}</template></el-table-column><el-table-column label="金额" width="110"><template #default="{row}">{{ money(row.totalAmount) }}</template></el-table-column><el-table-column prop="statusText" label="状态" width="100" /></el-table>
      </div>
      <template #footer><el-button @click="state.rankPreviewDialog=false">取消</el-button><el-button type="primary" @click="confirmRankJump">进入订单管理</el-button></template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.exportDialog" title="选择导出报表" width="620px">
      <div class="export-picker"><button v-for="item in exportOptions" :key="item.key" :class="{active:state.exportType===item.key}" @click="state.exportType=item.key"><strong>{{ item.name }}</strong><span>{{ item.desc }}</span><em>?? {{ item.rows }} ?</em></button></div>
      <div v-if="state.exportType==='reconciliationPersonal' && canUseHeadquarterReconciliation" class="export-target-panel"><label><span>指定导出对象</span><el-select v-model="exportTargetValue" filterable placeholder="选择商家、分销员、摄影师或客服"><el-option v-for="item in reconciliationExportTargetOptions" :key="item.value || 'all'" :label="item.label" :value="item.value" /></el-select></label><p>不选择具体对象时，导出当前筛选范围内全部可见主体；选择客服时导出客服经手业绩，不包含分成金额。</p></div>
      <div class="export-confirm"><strong>{{ selectedExportOption.name }}</strong><span>{{ selectedExportOption.desc }}</span><b>当前筛选范围预计导出 {{ exportPreviewRowsCount }} 条</b></div>
      <template #footer><el-button @click="state.exportDialog=false">取消</el-button><el-button type="primary" @click="confirmExport">确认导出</el-button></template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.reminderPreviewDialog" title="关键待办预览" width="860px">
      <div v-if="state.reminderPreview" class="rank-preview">
        <div class="rank-preview-head"><div><h2>{{ state.reminderPreview.label }}</h2><p>先预览订单，再决定是否进入订单管理处理。</p></div><el-tag>{{ state.reminderPreview.count }} 单</el-tag></div>
        <div class="content-kpis rank-preview-kpis"><div><span>订单数</span><strong>{{ state.reminderPreview.rows.length }}</strong></div><div><span>订单金额</span><strong>{{ money(state.reminderPreview.amount) }}</strong></div><div><span>待收尾款</span><strong>{{ money(state.reminderPreview.dueAmount) }}</strong></div></div>
        <el-table :data="state.reminderPreview.rows" height="360" stripe empty-text="暂无待办订单" @row-click="(row)=>openOrder(row,{readonly:true})"><el-table-column prop="orderNo" label="订单号" width="135" /><el-table-column prop="customer" label="客户" width="100" /><el-table-column label="商家"><template #default="{row}">{{ shopName(row.shopId) }}</template></el-table-column><el-table-column label="负责客服" width="110"><template #default="{row}">{{ staffName(row.assigneeId) }}</template></el-table-column><el-table-column prop="appointmentAt" label="预约时间" width="150" /><el-table-column label="金额" width="110"><template #default="{row}">{{ money(row.totalAmount) }}</template></el-table-column><el-table-column label="财务待收" width="110"><template #default="{row}">{{ money(financeDue(row)) }}</template></el-table-column><el-table-column fixed="right" label="操作" width="90"><template #default="{row}"><el-button link @click.stop="openOrder(row,{readonly:true})">详情</el-button></template></el-table-column></el-table>
      </div>
      <template #footer><el-button @click="state.reminderPreviewDialog=false">关闭</el-button><el-button type="primary" @click="confirmReminderJump">进入订单管理</el-button></template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.metricDialog" :title="drillTitle" width="1120px">
      <div class="metric-filter">

        <label><span>商家</span><el-select v-model="state.metricFilters.shopId" clearable filterable placeholder="全部商家"><el-option v-for="s in scopedShops" :key="s.id" :label="s.name" :value="s.id" /></el-select></label>
        <label><span>二维码位置</span><el-select v-model="state.metricFilters.scene" clearable placeholder="全部位置"><el-option v-for="scene in metricScenes" :key="scene" :label="scene" :value="scene" /></el-select></label>
        <label><span>状态</span><el-select v-model="state.metricFilters.status" clearable placeholder="全部状态"><el-option v-if="state.dashboardDrill==='scan'" label="已转化" value="已转化" /><el-option v-if="state.dashboardDrill==='scan'" label="浏览未下单" value="浏览未下单" /><el-option v-if="state.dashboardDrill!=='scan'" label="待确认" value="待确认" /><el-option v-if="state.dashboardDrill!=='scan'" label="已接单" value="已接单" /><el-option v-if="state.dashboardDrill!=='scan'" label="拍摄中" value="拍摄中" /><el-option v-if="state.dashboardDrill!=='scan'" label="已完成" value="已完成" /></el-select></label>
        <label><span>关键词</span><el-input v-model="state.metricFilters.keyword" clearable placeholder="客户/订单/商家/openid" /></label>
        <el-button @click="resetMetricFilters">重置</el-button>
      </div>
      <div v-if="state.dashboardDrill==='scan'" class="metric-summary scan-detail-summary"><div><span>扫码量</span><strong>{{ scanMetricSummary.scans }}</strong></div><div><span>去重访客</span><strong>{{ scanMetricSummary.unique }}</strong></div><div><span>浏览未下单</span><strong>{{ scanMetricSummary.browseOnly }}</strong></div><div><span>转化订单</span><strong>{{ scanMetricSummary.converted }}</strong></div><div><span>涉及商家</span><strong>{{ scanMetricSummary.shops }}</strong></div><div><span>转化成交</span><strong>{{ money(scanMetricSummary.amount) }}</strong></div></div>
      <div v-else class="metric-summary"><div><span>当前明细</span><strong>{{ drillRows.length }}</strong></div><div><span>成交额</span><strong>{{ money(drillRows.reduce((s,row)=>s+Number(row.totalAmount||0),0)) }}</strong></div><div><span>已收</span><strong>{{ money(drillRows.reduce((s,row)=>s+Number(row.depositPaid||0)+Number(row.finalPaid||0),0)) }}</strong></div></div>
      <el-table v-if="state.dashboardDrill==='scan'" :data="drillRows" stripe height="520" @row-click="drillRowClick">
        <el-table-column prop="date" label="扫码日期" width="115" />
        <el-table-column label="时段" width="80"><template #default="{row}">{{ String(row.hour).padStart(2,'0') }}:00</template></el-table-column>

        <el-table-column label="分销员" min-width="160"><template #default="{row}">{{ (row.distributorIds && row.distributorIds.length) ? row.distributorIds.map(distributorName).join('、') : (distributorName(row.distributorId) || '总部直营') }}</template></el-table-column>
        <el-table-column label="商家" min-width="150"><template #default="{row}">{{ shopName(row.shopId) }}</template></el-table-column>
        <el-table-column prop="scene" label="二维码位置" width="130" />
        <el-table-column prop="openid" label="访客OpenID" min-width="130" />
        <el-table-column prop="status" label="转化状态" width="110" />
        <el-table-column label="关联订单/客户" min-width="160"><template #default="{row}">{{ row.orderNo }}<div class="muted">{{ row.customer }}</div></template></el-table-column>
        <el-table-column label="转化金额" width="110"><template #default="{row}">{{ row.totalAmount ? money(row.totalAmount) : '-' }}</template></el-table-column>
      </el-table>
      <el-table v-else :data="drillRows" stripe height="520" @row-click="drillRowClick">
        <el-table-column prop="date" label="日期" width="120" />

        <el-table-column label="商家" width="140"><template #default="{row}">{{ shopName(row.shopId) }}</template></el-table-column>
        <el-table-column prop="scene" label="二维码位置" width="150" />
        <el-table-column label="订单/客户"><template #default="{row}">{{ row.orderNo || row.customer || row.openid }}</template></el-table-column>
        <el-table-column label="金额" width="110"><template #default="{row}">{{ row.totalAmount ? money(row.totalAmount) : '-' }}</template></el-table-column>
        <el-table-column label="定金/尾款" width="150"><template #default="{row}">{{ row.depositPaid !== undefined ? money(row.depositPaid) + ' / ' + money(row.finalPaid) : '-' }}</template></el-table-column>
        <el-table-column label="财务待收" width="110"><template #default="{row}">{{ row.totalAmount ? money(financeDue(row)) : '-' }}</template></el-table-column>
        <el-table-column prop="status" label="状态" width="120" />
      </el-table>
      <template #footer><el-button @click="state.metricDialog=false">关闭</el-button><el-button type="primary" @click="state.metricDialog=false; switchMenu('orders',{preserveFilters:true})">进入订单管理</el-button></template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.reconciliationDialog" :title="state.reconciliationDetail.title" width="1120px">
      <div class="reconcile-detail-head">
        <p>{{ state.reconciliationDetail.desc }}</p>
        <div><span>订单数</span><strong>{{ state.reconciliationDetail.rows.length }}</strong></div>
        <div><span>{{ state.reconciliationDetail.amountLabel }}</span><strong>{{ money(state.reconciliationDetail.rows.reduce((s,row)=>s+reconciliationDetailAmount(row,state.reconciliationDetail.type),0)) }}</strong></div>
      </div>
      <div v-if="state.reconciliationDetail.record" class="settlement-record-summary">
        <div><span>结算主体</span><strong>{{ state.reconciliationDetail.record.objectType }} · {{ state.reconciliationDetail.record.objectName }}</strong></div>
        <div><span>结算周期</span><strong>{{ state.reconciliationDetail.record.settlementCycle }} · {{ state.reconciliationDetail.record.period }}</strong></div>
        <div><span>实结金额</span><strong>{{ money(state.reconciliationDetail.record.amount) }}</strong></div>
        <div><span>当前状态</span><strong>{{ settlementRecordStage(state.reconciliationDetail.record) }}</strong></div>
        <div><span>确认人</span><strong>{{ state.reconciliationDetail.record.operator }} · {{ state.reconciliationDetail.record.time }}</strong></div>
        <div><span>打款记录</span><strong>{{ state.reconciliationDetail.record.paidAt ? state.reconciliationDetail.record.paidBy + ' · ' + state.reconciliationDetail.record.paidAt : '未确认打款' }}</strong></div>
      </div>
      <el-table :data="state.reconciliationDetail.rows" stripe height="540" @row-click="(row)=>row.orderNo && openOrder(row,{readonly:true})">
        <el-table-column prop="orderNo" label="订单号" width="135" />
        <el-table-column prop="customer" label="客户" width="100" />
        <el-table-column label="订单来源/渠道" min-width="230"><template #default="{row}"><strong>{{ orderSourceTypeText(row) }}</strong><div class="muted">{{ orderSourceName(row) }}</div></template></el-table-column>
        <el-table-column label="收入类型" width="110"><template #default="{row}">{{ settlementIncomeType(row) }}</template></el-table-column>
        <el-table-column label="跟进客服" width="110"><template #default="{row}">{{ staffName(row.assigneeId) }}</template></el-table-column>
        <el-table-column label="摄影师" width="110"><template #default="{row}">{{ staffName(row.photographerId) }}</template></el-table-column>
        <el-table-column v-if="state.reconciliationDetail.type==='settlementDue'" label="结算对象" min-width="150"><template #default="{row}">{{ row.settlementSubjectType || '-' }} {{ row.settlementSubjectName || '' }}</template></el-table-column>
        <el-table-column v-if="state.reconciliationDetail.type==='settlementDue'" prop="settlementPeriod" label="结算周期" width="180" />
        <el-table-column prop="appointmentAt" label="预约时间" width="120" />
        <el-table-column label="订单金额" width="110"><template #default="{row}">{{ money(row.totalAmount) }}</template></el-table-column>
        <el-table-column label="财务待收" width="100"><template #default="{row}">{{ money(financeDue(row)) }}</template></el-table-column>
        <el-table-column label="应计/核对" width="120"><template #default="{row}">{{ money(reconciliationDetailAmount(row,state.reconciliationDetail.type)) }}</template></el-table-column>
        <el-table-column label="状态" width="100"><template #default="{row}">{{ orderWorkflowStatusLabel(row) }}</template></el-table-column>
        <el-table-column fixed="right" label="操作" width="210"><template #default="{row}"><el-button link @click.stop="openOrder(row,{readonly:true})">详情</el-button><el-button v-if="state.reconciliationDetail.type==='observation' && canReleaseSettlementObservation(row)" link type="warning" @click.stop="releaseSettlementObservation(row)">结束静置期</el-button><el-button v-if="state.reconciliationDetail.type==='retained' && canUseHeadquarterReconciliation" link type="danger" @click.stop="openRetentionAdjustment(row)">留存冲正</el-button></template></el-table-column>
      </el-table>
      <template #footer><el-button @click="state.reconciliationDialog=false">关闭</el-button></template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.manualOrderDialog" title="创建订单" width="860px" class="manual-order-dialog">
      <div class="dialog-note">客服先完整录入客户、来源、商品和预约信息，点击确定创建后才生成正式订单并绑定当前客服。</div>
      <div class="form-grid labeled-form">
        <label><span>客户姓名</span><el-input v-model="state.manualOrderForm.customer" placeholder="请输入客户姓名" /></label>
        <label><span>手机号</span><el-input v-model="state.manualOrderForm.phone" placeholder="请输入客户手机号" /></label>
        <label><span>微信号</span><el-input v-model="state.manualOrderForm.wechat" placeholder="可选，便于客服跟进" /></label>
        <label><span>订单来源</span><el-select v-model="state.manualOrderForm.sourceType"><el-option label="客服手动创建" value="manual" /><el-option label="总部二维码" value="headquarter" /><el-option label="商家二维码" value="shop" /></el-select></label>
        <label v-if="state.manualOrderForm.sourceType==='shop'"><span>来源商家</span><el-select v-model="state.manualOrderForm.shopId" clearable filterable placeholder="选择商家"><el-option v-for="s in scopedShops" :key="s.id" :label="s.name" :value="s.id" /></el-select></label>
        <label v-if="state.manualOrderForm.sourceType==='shop'"><span>绑定分销员</span><el-select v-model="state.manualOrderForm.distributorId" clearable filterable placeholder="无分销员可不选"><el-option v-for="d in visibleDistributors" :key="d.id" :label="d.name" :value="d.id" /></el-select></label>
        <label class="wide"><span>下单商品</span><el-select v-model="state.manualOrderForm.productId" filterable placeholder="选择套餐、短视频、增值服务或周边"><el-option v-for="p in manualOrderProducts" :key="p.productType + '-' + p.id" :label="p.name + ' / ' + money(p.specialPrice || p.price || 0)" :value="p.id" /></el-select></label>
        <label><span>拍摄时间</span><el-date-picker v-model="state.manualOrderForm.appointmentAt" type="datetime" value-format="YYYY-MM-DD HH:mm" format="YYYY-MM-DD HH:mm" placeholder="选择拍摄时间" /></label>
        <label><span>预约时段</span><el-select v-model="state.manualOrderForm.timePeriod"><el-option label="上午" value="上午" /><el-option label="下午" value="下午" /><el-option label="晚上" value="晚上" /><el-option label="待客服确认" value="待客服确认" /></el-select></label>
        <label><span>已收定金</span><el-input-number v-model="state.manualOrderForm.depositPaid" :min="0" /></label>
        <label class="wide"><span>内部备注</span><el-input v-model="state.manualOrderForm.internalNote" type="textarea" :rows="3" placeholder="仅后台可见，例如沟通重点、服装需求、特殊行程" /></label>
      </div>
      <template #footer>
        <el-button @click="state.manualOrderDialog=false">取消</el-button>
        <el-button type="primary" @click="confirmCreateManualOrder">确定创建</el-button>
      </template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.dispatchDialog" title="安排摄影师" width="620px">
      <div class="form-grid labeled-form single">
        <label><span>摄影师</span><el-select v-model="state.dispatchForm.photographerId" filterable placeholder="请选择摄影师"><el-option v-for="s in photographers" :key="s.id" :label="s.name" :value="s.id" /></el-select></label>
        <label><span>派单备注</span><el-input v-model="state.dispatchForm.note" type="textarea" :rows="3" placeholder="例如客人偏好、拍摄地点、注意事项" /></label>
      </div>
      <template #footer>
        <el-button @click="state.dispatchDialog=false">取消</el-button>
        <el-button type="primary" @click="confirmDispatchPhotographer">确认安排</el-button>
      </template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.transferDialog" title="订单转派/交接" width="620px">
      <div class="dialog-note">用于客服请假、离职、服务中途交接或总部改派。转派完成后会写入订单时间线和操作日志。</div>
      <div class="form-grid labeled-form single">
        <label>
          <span>转给客服</span>
          <el-select v-model="state.transferForm.assigneeId" filterable placeholder="请选择接手客服" :disabled="!canTransferCustomerService(state.currentOrder)">
            <el-option v-for="s in services" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </label>
        <label v-if="state.role==='super'">
          <span>改派摄影师</span>
          <el-select v-model="state.transferForm.photographerId" filterable clearable placeholder="请选择新的摄影师" :disabled="!canTransferPhotographer(state.currentOrder)">
            <el-option v-for="s in photographers" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </label>
        <label>
          <span>交接原因</span>
          <el-input v-model="state.transferForm.note" type="textarea" :rows="3" placeholder="例如：客服请假、离职交接、摄影师档期冲突、总部临时改派" />
        </label>
      </div>
      <template #footer>
        <el-button @click="state.transferDialog=false">取消</el-button>
        <el-button type="primary" @click="confirmTransferOrder">确认转派</el-button>
      </template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.batchNoteDialog" title="批量备注" width="620px">
      <div class="dialog-note">批量备注会写入订单内部备注和操作时间线；售后锁定、已完成、已取消订单会自动跳过。</div>
      <div class="form-grid labeled-form single">
        <label><span>备注内容</span><el-input v-model="state.batchNoteText" type="textarea" :rows="4" placeholder="例如：客服A请假，本批订单先由客服B接手跟进。" /></label>
      </div>
      <template #footer>
        <el-button @click="state.batchNoteDialog=false">取消</el-button>
        <el-button type="primary" @click="confirmBatchNote">确认添加备注</el-button>
      </template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.exceptionDialog" title="超管异常处理" width="860px">
      <div v-if="state.currentOrder" class="dialog-note danger">仅用于总部兜底处理异常订单。状态回退、来源归属修正、强制改派、风控/财务锁定解除都会写入订单时间线和操作日志。</div>
      <div v-if="state.currentOrder" class="exception-dialog-grid">
        <label><span>后台订单状态</span><el-select v-model="state.exceptionForm.status"><el-option v-for="s in statusDict" :key="s.value" :label="s.label" :value="s.value" /></el-select></label>
        <label><span>客人可见状态</span><el-select v-model="state.exceptionForm.customerStatus"><el-option v-for="s in LXM_CONFIG.visibleStatus" :key="s.value" :label="s.label" :value="s.value" /></el-select></label>
        <label><span>订单来源</span><el-select v-model="state.exceptionForm.sourceType"><el-option label="总部二维码" value="headquarter" /><el-option label="商家二维码" value="shop" /><el-option label="小程序自然下单" value="natural" /><el-option label="客服手动创建" value="manual" /></el-select></label>
        <label><span>归属商家</span><el-select v-model="state.exceptionForm.shopId" filterable clearable :disabled="state.exceptionForm.sourceType==='headquarter'" placeholder="选择商家"><el-option v-for="s in scopedShops" :key="s.id" :label="s.name" :value="s.id" /></el-select></label>
        <label><span>绑定分销员</span><el-select v-model="state.exceptionForm.distributorId" filterable clearable :disabled="state.exceptionForm.sourceType==='headquarter'" placeholder="无分销员"><el-option v-for="d in visibleDistributors" :key="d.id" :label="d.name" :value="d.id" /></el-select></label>
        <label><span>强制改派摄影师</span><el-select v-model="state.exceptionForm.forcePhotographerId" filterable clearable placeholder="总部摄影/未安排"><el-option v-for="p in photographers" :key="p.id" :label="p.name" :value="p.id" /></el-select></label>
        <label class="switch-line"><span>风控处理</span><el-switch v-model="state.exceptionForm.clearRisk" active-text="解除风控/冻结标记" /></label>
        <label class="switch-line"><span>财务锁定</span><el-switch v-model="state.exceptionForm.clearFinanceLock" active-text="解除待审财务锁定" /></label>
        <label class="wide"><span>异常处理原因</span><el-input v-model="state.exceptionForm.reason" type="textarea" :rows="4" placeholder="必填，例如：客服误操作状态、商家归属录错、总部核实后解除风控。" /></label>
      </div>
      <template #footer>
        <el-button @click="state.exceptionDialog=false">取消</el-button>
        <el-button type="danger" @click="confirmOrderException">确认异常处理并留痕</el-button>
      </template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.rescheduleDialog" title="改期拍摄" width="620px">
      <div class="form-grid labeled-form single">
        <label><span>新拍摄时间</span><el-date-picker v-model="state.rescheduleForm.appointmentAt" type="datetime" value-format="YYYY-MM-DD HH:mm" format="YYYY-MM-DD HH:mm" placeholder="选择新的拍摄时间" /></label>
        <label><span>新预约时段</span><el-select v-model="state.rescheduleForm.timePeriod"><el-option label="上午" value="上午" /><el-option label="下午" value="下午" /><el-option label="晚上" value="晚上" /><el-option label="待客服确认" value="待客服确认" /></el-select></label>
        <label><span>改期原因</span><el-input v-model="state.rescheduleForm.reason" type="textarea" :rows="3" placeholder="例如客人行程变化、天气原因、摄影师档期调整" /></label>
      </div>
      <template #footer>
        <el-button @click="state.rescheduleDialog=false">取消</el-button>
        <el-button type="primary" @click="confirmReschedule">确认改期</el-button>
      </template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.settlementDialog" title="确认结算批次" width="860px" class="settlement-dialog">
      <div v-if="state.settlementTarget" class="settlement-confirm">
        <div class="settlement-confirm-head">
          <div><span>结算对象</span><strong>{{ state.settlementTarget.typeName }} · {{ state.settlementTarget.name }}</strong></div>
          <div><span>结算周期</span><strong>{{ state.settlementTarget.settlementCycle }} · {{ state.settlementTarget.settlementPeriod }}</strong></div>
          <div><span>分成比例</span><strong>{{ state.settlementTarget.rateText || '-' }}</strong></div>
          <div><span>本批应计</span><strong>{{ money(state.settlementTarget.commission || state.settlementTarget.settlementAmount || 0) }}</strong></div>
        </div>
        <div class="settlement-confirm-form">
          <label><span>本次实结分成金额</span><el-input-number v-model="state.settlementForm.amount" :min="0" :step="0.01" :precision="2" :controls="false" /></label>
          <label><span>付款方式（选填）</span><el-input v-model="state.settlementForm.method" placeholder="如：微信转账 / 银行转账" /></label>
          <label><span>凭证号（选填）</span><el-input v-model="state.settlementForm.voucherNo" placeholder="填写转账单号或凭证编号" /></label>
          <label><span>备注（选填）</span><el-input v-model="state.settlementForm.note" placeholder="如：本周结算，已线下转账" /></label>
        </div>
        <div class="section-title-row compact"><h3>本批次结算订单</h3><el-button size="small" plain @click="refreshSettlementFormAmount">按已选订单重算金额</el-button></div>
        <div class="finance-risk-note">确认结算会生成永久结算记录；后续如发生退款或调账，不修改原记录，统一进入冲正台账抵扣下一期待结算。当前大额复核阈值：{{ money(largeSettlementThreshold()) }}，达到阈值必须填写凭证号和备注。</div>
        <el-table :data="settlementDialogOrders" height="320" stripe empty-text="暂无可结算订单">
          <el-table-column width="48">
            <template #default="{row}">
              <el-checkbox v-model="state.settlementForm.selectedOrderIds" :label="row.id" @change="refreshSettlementFormAmount">&nbsp;</el-checkbox>
            </template>
          </el-table-column>
          <el-table-column prop="orderNo" label="订单号" width="135" />
          <el-table-column prop="customer" label="客户" width="100" />
          <el-table-column label="订单来源" min-width="160"><template #default="{row}">{{ orderSourceName(row) }}</template></el-table-column>
          <el-table-column label="入池净额" width="110" align="right"><template #default="{row}">{{ money(netOrderAmount(row)) }}</template></el-table-column>
          <el-table-column label="本对象应结" width="120" align="right"><template #default="{row}">{{ money(settlementOrderAmount(row,state.settlementTarget)) }}</template></el-table-column>
          <el-table-column prop="appointmentAt" label="预约时间" width="145" />
        </el-table>
      </div>
      <template #footer>
        <el-button @click="state.settlementDialog=false">取消</el-button>
        <el-button type="primary" @click="submitSettlementBatch">确认已结算</el-button>
      </template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.adjustmentDialog" title="发起退款 / 冲正调账" width="620px">
      <div class="labeled-form">
        <label><span>关联订单号</span><el-input v-model="state.adjustmentForm.orderNo" placeholder="请输入订单号，如 LS202606101" /></label>
        <label><span>冲正类型</span><el-select v-model="state.adjustmentForm.type"><el-option label="结算后退款" value="结算后退款" /><el-option label="人工调账" value="人工调账" /><el-option label="红字冲正" value="红字冲正" /></el-select></label>
        <label><span>冲正金额</span><el-input-number v-model="state.adjustmentForm.amount" :min="0" :step="10" /></label>
        <label><span>扣减主体</span><el-select v-model="state.adjustmentForm.targetType"><el-option label="商家" value="商家" /><el-option label="分销员" value="分销员" /><el-option label="摄影师" value="摄影师" /><el-option label="总部" value="总部" /></el-select></label>
        <label><span>主体名称</span><el-input v-model="state.adjustmentForm.targetName" placeholder="填写被扣减或调账的主体名称" /></label>
        <label><span>凭证附件</span><el-input v-model="state.adjustmentForm.attachment" placeholder="填写附件名或线下凭证编号" /></label>
        <label class="wide"><span>备注说明</span><el-input v-model="state.adjustmentForm.note" type="textarea" :rows="4" placeholder="说明退款、冲正或人工调账原因，便于后续审计追溯" /></label>
      </div>
      <template #footer>
        <el-button @click="state.adjustmentDialog=false">取消</el-button>
        <el-button type="primary" @click="submitAdjustmentRecord">提交冲正</el-button>
      </template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.imagePreview" title="样片放大预览" width="860px"><img class="zoom-img" :src="state.zoomUrl" /></el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.timelineDialog" title="操作时间线" width="620px">
      <div v-if="state.currentOrder" class="timeline-dialog-list">
        <div class="timeline-filter-tabs">
          <button :class="{active:!state.timelineCategoryFilter}" @click="state.timelineCategoryFilter=''">全部</button>
          <button v-for="cat in orderTimelineCategoryOptions(state.currentOrder)" :key="cat" :class="{active:state.timelineCategoryFilter===cat}" @click="state.timelineCategoryFilter=cat">{{ cat }}</button>
        </div>
        <div v-for="(logItem,index) in filteredOrderTimelineRows(state.currentOrder)" :key="logItem.sort || index" class="timeline-row">
          <span class="timeline-index">{{ index + 1 }}</span>
          <div class="timeline-card">
            <div class="timeline-meta">
              <b>{{ logItem.time }}</b>
              <em>{{ logItem.operator }}</em>
            </div>
            <span class="timeline-category" :data-category="logItem.category">{{ logItem.category || '记录' }}</span>
            <strong>{{ logItem.action }}</strong>
          </div>
        </div>
      </div>
      <template #footer><el-button type="primary" @click="state.timelineDialog=false">关闭</el-button></template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.staffDialog" title="人员账号与权限" width="860px">
      <div v-if="state.editStaff">
        <div class="form-grid labeled-form">
          <label><span>姓名</span><el-input v-model="state.editStaff.name" placeholder="请输入员工姓名" /></label>
          <label><span>登录账号</span><el-input v-model="state.editStaff.account" placeholder="用于后台登录" /></label>
          <label><span>登录密码</span><el-input v-model="state.editStaff.password" type="password" show-password placeholder="至少 8 位，含字母和数字；编辑时留空则不修改" /></label>
          <label><span>手机号</span><el-input v-model="state.editStaff.phone" placeholder="员工联系电话" /></label>
          <label><span>角色</span><el-select v-model="state.editStaff.role" placeholder="选择角色" @change="applyRoleDefaultPermissions"><el-option v-for="(r,k) in LXM_CONFIG.roles" :key="k" :label="r.name" :value="k" /></el-select></label>
          <label v-if="state.editStaff.role==='photo'"><span>摄影师分成比例</span><el-input-number v-model="state.editStaff.commissionRate" :min="0" :max="100" /><em>%</em></label>
          <label v-if="state.editStaff.role==='photo'"><span>摄影师结算周期</span><el-select v-model="state.editStaff.settlementCycle" placeholder="选择结算周期"><el-option v-for="c in LXM_CONFIG.settlementCycles" :key="c" :label="c" :value="c" /></el-select></label>
        </div>
        <div class="permission-edit"><div class="section-title-row"><h3>权限配置</h3><el-button size="small" @click="applyRoleDefaultPermissions">套用角色默认权限</el-button></div><el-checkbox-group v-model="state.editStaff.permissionKeys"><el-checkbox v-for="p in LXM_CONFIG.permissionMatrix" :key="p.key" :label="p.key">{{ p.name }}</el-checkbox></el-checkbox-group><p>人员管理只维护内部账号、角色权限和摄影师分成规则；订单、营业额、月度核对统一到经营看板和财务管理查看。</p></div>
      </div>
      <template #footer><el-button @click="state.staffDialog=false">取消</el-button><el-button type="primary" @click="saveStaff">保存</el-button></template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.distributorDialog" title="分销员账号配置" width="620px">
      <div v-if="state.editDistributor">
        <div class="dialog-note">分销员是个人推广账号。总部在商家管理中把商家绑定给分销员，分销员不能自行新增商家。</div>
        <div class="form-grid labeled-form">
          <label><span>分销员姓名</span><el-input v-model="state.editDistributor.name" placeholder="请输入姓名" /></label>
          <label><span>手机号</span><el-input v-model="state.editDistributor.phone" placeholder="分销员联系电话" /></label>
          <label><span>登录账号</span><el-input v-model="state.editDistributor.account" placeholder="用于后台登录" /></label>
          <label><span>登录密码</span><el-input v-model="state.editDistributor.password" type="password" show-password placeholder="至少 8 位，含字母和数字；编辑时留空则不修改" /></label>
          <label><span>分销分成比例</span><el-input-number v-model="state.editDistributor.commissionRate" :min="0" :max="100" /><em>%</em></label>
          <label><span>结算周期</span><el-select v-model="state.editDistributor.settlementCycle" placeholder="选择结算周期"><el-option v-for="c in LXM_CONFIG.settlementCycles" :key="c" :label="c" :value="c" /></el-select></label>
          <label><span>账号状态</span><el-select v-model="state.editDistributor.status" placeholder="选择状态"><el-option label="启用" value="启用" /><el-option label="停用" value="停用" /></el-select></label>
        </div>
        <div class="distributor-shops" v-if="state.editDistributor && state.editDistributor.id">
          <div class="section-title-row compact"><h3>共推门店</h3><span class="muted">该分销员当前绑定推广的商家与在本店的提成比例（在「商家基础配置」里维护）。</span></div>
          <div class="tag-list">
            <span v-for="s in data.shops.filter(x => (x.distributorIds||[]).includes(state.editDistributor.id))" :key="s.id" class="lxm-tag">{{ s.name }} · 提成 {{ distributorRateForShop(s, state.editDistributor.id) }}%</span>
            <span v-if="!data.shops.filter(x => (x.distributorIds||[]).includes(state.editDistributor.id)).length" class="muted">暂未绑定任何商家</span>
          </div>
        </div>
      </div>
      <template #footer><el-button @click="state.distributorDialog=false">取消</el-button><el-button type="primary" @click="saveDistributor">保存</el-button></template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.shopDialog" title="商家资料与分账配置" width="860px">
      <div v-if="state.editShop">
        <div class="dialog-note">商家管理负责门店资料、商家二维码物料、绑定分销员、商家分成比例和结算周期。经营数据请到经营看板或月度对账查看。</div>
        <div class="form-grid labeled-form">
          <label><span>商家名称</span><el-input v-model="state.editShop.name" placeholder="请输入商家/门店名称" /></label>
          <label><span>门店联系人</span><el-input v-model="state.editShop.contact" placeholder="商家负责人或对接人" /></label>
          <label><span>联系电话</span><el-input v-model="state.editShop.phone" placeholder="商家联系电话" /></label>
          <label><span>门店地址</span><el-input v-model="state.editShop.address" placeholder="商家门店地址" /></label>
          <label class="full-width"><span>绑定分销员(可多选)</span><el-select v-model="state.editShop.distributorIds" multiple clearable filterable placeholder="可绑定/解绑多名分销员；该店订单的分销分成按绑定名单分摊" @change="syncShopDistributorRates"><el-option v-for="d in visibleDistributors" :key="d.id" :label="d.name + ' · 默认 ' + d.commissionRate + '%'" :value="d.id" /></el-select></label>
          <div v-if="state.editShop.distributorIds && state.editShop.distributorIds.length" class="shop-distributor-rates">
            <div class="section-title-row compact"><h3>逐店分销提成</h3><span class="muted">为每家分销员单独设置本店提成比例（管理员设定）；不填则用该分销员默认比例。</span></div>
            <div class="rate-rows">
              <div class="rate-row" v-for="d in visibleDistributors.filter(x => (state.editShop.distributorIds||[]).includes(x.id))" :key="d.id">
                <span class="rate-name">{{ d.name }}</span>
                <el-input-number v-model="state.editShop.distributorRates[d.id]" :min="0" :max="100" :controls="false" />
                <em>%</em>
              </div>
            </div>
          </div>
          <label><span>二维码场景</span><el-input v-model="state.editShop.scene" placeholder="如门店台卡、桌贴、海报" /></label>
          <label><span>二维码位置</span><el-input v-model="state.editShop.qrPosition" placeholder="如收银台、靠窗区、前台海报" /></label>
          <label><span>商家登录账号</span><el-input v-model="state.editShop.account" placeholder="商家后台登录账号" /></label>
          <label><span>商家登录密码</span><el-input v-model="state.editShop.password" type="password" show-password placeholder="至少 8 位，含字母和数字；编辑时留空则不修改" /></label>
          <label><span>商家分成比例</span><el-input-number v-model="state.editShop.commissionRate" :min="0" :max="100" /><em>%</em></label>
          <label><span>结算周期</span><el-select v-model="state.editShop.settlementCycle" placeholder="选择结算周期"><el-option v-for="c in LXM_CONFIG.settlementCycles" :key="c" :label="c" :value="c" /></el-select></label>
          <label><span>合作状态</span><el-select v-model="state.editShop.status"><el-option label="合作中" value="合作中" /><el-option label="暂停合作" value="暂停合作" /></el-select></label>
        </div>
      </div>
      <template #footer><el-button @click="state.shopDialog=false">取消</el-button><el-button type="primary" @click="saveShop">保存</el-button></template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.qrDialog" title="商家二维码生成器" width="620px">
      <div v-if="state.currentShop" class="qr-gen">
        <div class="qr-shop-head">
          <h3>{{ state.currentShop.name }}</h3>
          <span class="qr-shop-id">{{ state.currentShop.shopId }}</span>
        </div>

        <div class="qr-stats">
          <div class="qr-stat"><b>{{ state.merchantCodeStats.scans }}</b><span>扫码量</span></div>
          <div class="qr-stat"><b>{{ state.merchantCodeStats.orders }}</b><span>订单</span></div>
          <div class="qr-stat"><b>{{ state.merchantCodeStats.deals }}</b><span>成交</span></div>
          <div class="qr-stat"><b>{{ state.merchantCodeStats.codeCount }}</b><span>码数</span></div>
        </div>

        <div class="qr-generate">
          <div class="qr-block-label">铺放位置（一位置一码）</div>
          <div class="qr-pos-list">
            <button v-for="p in state.qrPositions" :key="p.type" type="button"
              :class="['qr-pos', { active: !state.qrCustomLabel && state.qrPlacementType === p.type }]"
              @click="state.qrPlacementType = p.type; state.qrCustomLabel = ''">{{ p.label }}</button>
          </div>
          <div class="qr-custom-pos">
            <span class="qr-custom-hint">或自定义位置</span>
            <el-input v-model="state.qrCustomLabel" maxlength="20" show-word-limit placeholder="如 前台 / 门口海报 / 3楼电梯" />
          </div>
          <el-button type="primary" :loading="state.qrGenerating" @click="generateMerchantQr">生成二维码</el-button>
        </div>

        <div v-if="state.qrPreview" class="qr-preview">
          <img v-if="state.qrPreview.qrImage" :src="state.qrPreview.qrImage" class="qr-img" alt="商家二维码" />
          <div v-else class="qr-img qr-img-empty">部署后将生成真实可扫码小程序码</div>
          <div class="qr-preview-meta">
            <div>位置：{{ state.qrPreview.placementLabel }}</div>
            <div class="qr-code-id">短码：{{ state.qrPreview.codeId }}</div>
            <div class="qr-path">路径：pages/scanEntry/scanEntry?c={{ state.qrPreview.codeId }}</div>
          </div>
          <el-button @click="downloadMerchantQr()">下载物料</el-button>
        </div>

        <div class="qr-list" v-if="state.merchantCodes.length">
          <div class="qr-list-title">已生成（{{ state.merchantCodes.length }}）</div>
          <div v-for="c in state.merchantCodes" :key="c._id" class="qr-list-row">
            <div class="qr-list-info">
              <span class="qr-list-pos">{{ c.placementLabel }}</span>
              <span class="qr-list-sub">扫码 {{ c.scanCount }} · 订单 {{ c.orderCount }} · 成交 {{ c.dealCount }}</span>
            </div>
            <el-button size="small" @click="downloadMerchantQr(c)">下载</el-button>
          </div>
        </div>
      </div>
      <template #footer><el-button @click="state.qrDialog=false">关闭</el-button></template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.tagDialog" title="统一标签配置" width="620px">
      <div v-if="state.editTag" class="form-grid labeled-form">
        <label><span>标签名称</span><el-input v-model="state.editTag.name" placeholder="如 清新自然 / 情侣出游 / 暑期活动" /></label>
        <label><span>标签分类</span><el-select v-model="state.editTag.category"><el-option label="风格" value="风格" /><el-option label="场景" value="场景" /><el-option label="人群" value="人群" /><el-option label="活动" value="活动" /></el-select></label>
        <label><span>适用范围</span><el-input v-model="state.editTag.scope" placeholder="如 照片单品/套餐/货架" /></label>
        <label><span>排序权重</span><el-input-number v-model="state.editTag.sort" :min="0" /></label>
        <label><span>状态</span><el-select v-model="state.editTag.status"><el-option label="启用" value="启用" /><el-option label="停用" value="停用" /></el-select></label>
        <label><span>标识色</span><el-color-picker v-model="state.editTag.color" /></label>
      </div>
      <template #footer><el-button @click="state.tagDialog=false">取消</el-button><el-button type="primary" @click="saveTag">保存标签</el-button></template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.albumReplaceDialog" title="批量替换套餐绑定照片单品" width="620px">
      <div class="dialog-note">用于照片单品下架、素材禁用或素材升级时，将所有引用原照片单品的套餐批量切换到新照片单品。替换后套餐价格、上下架状态不变。</div>
      <div class="form-grid labeled-form single">
        <label><span>原照片单品</span><el-select v-model="state.albumReplaceForm.fromAlbumId" filterable placeholder="选择需要被替换的照片单品"><el-option v-for="a in data.albums" :key="a.id" :label="a.name + ' · 引用套餐 ' + packagesByAlbum(a.id).length" :value="a.id" /></el-select></label>
        <label><span>替换为</span><el-select v-model="state.albumReplaceForm.toAlbumId" filterable placeholder="选择新的素材照片单品"><el-option v-for="a in data.albums.filter(i=>i.id!==state.albumReplaceForm.fromAlbumId && i.allowMaterialUse!==false)" :key="a.id" :label="a.name + ' · ' + relationText(a)" :value="a.id" /></el-select></label>
      </div>
      <div v-if="state.albumReplaceForm.fromAlbumId" class="finance-risk-note">将影响 {{ packagesByAlbum(state.albumReplaceForm.fromAlbumId).length }} 个套餐。建议替换后到套餐设置页检查展示素材和前端预览。</div>
      <template #footer><el-button @click="state.albumReplaceDialog=false">取消</el-button><el-button type="primary" @click="submitAlbumReplace">确认替换</el-button></template>
    </el-dialog>
    <el-dialog :close-on-click-modal="false" v-model="state.contentDialog" :title="activeMenu.label + '编辑'" width="1120px" class="content-edit-dialog">
      <div v-if="state.editContent" class="content-edit-form">
        <div class="content-form-section">
          <div class="content-form-section-head"><strong>基础必填</strong><span>名称、状态和标签用于列表展示、搜索和前端露出判断。</span></div>
          <div class="form-grid">
            <label><span>{{ state.editContent.__key==='guides' ? '攻略标题' : '名称' }}</span><el-input v-model="state.editContent[state.editContent.__key==='guides' ? 'title' : 'name']" :placeholder="state.editContent.__key==='guides' ? '攻略标题（小程序展示标题）' : '名称'" /></label>
            <label v-if="state.editContent.__key!=='cities'"><span>状态</span><el-select v-model="state.editContent.status" clearable placeholder="状态"><el-option label="启用" value="启用" /><el-option label="上架" value="上架" /><el-option label="草稿" value="草稿" /><el-option label="下架" value="下架" /><el-option label="停用" value="停用" /></el-select></label>
            <label v-if="state.editContent.__key!=='cities'"><span>运营标签</span><el-select v-model="state.editContent.tag" clearable filterable allow-create placeholder="从统一标签库选择标签"><el-option v-for="t in tagOptions()" :key="t.id" :label="t.name + ' · ' + t.category" :value="t.name" /></el-select></label>
            <label v-if="state.editContent.__key==='packages'"><span>商品类型</span><el-select v-model="state.editContent.type" clearable placeholder="商品类型"><el-option label="拍照" value="photo" /><el-option label="短视频" value="video" /></el-select></label>
            <label v-if="state.editContent.__key==='packages'" class="switch-line"><span>首页推荐</span><el-switch v-model="state.editContent.isMainPush" active-text="全局主推套餐" /></label>
            <label v-if="state.editContent.__key==='packages'" class="switch-line"><span>热推置顶</span><el-switch v-model="state.editContent.isHot" active-text="首页热推商品" /></label>
            <label v-if="state.editContent.__key==='packages'"><span>热度分</span><el-input-number v-model="state.editContent.hotScore" :min="0" :max="100" /></label>
          </div>
        </div>
        <div class="content-form-section">
          <div class="content-form-section-head"><strong>关联归属</strong><span>用于打卡点、拍摄风格、照片单品之间的前台展示链路和后台筛选。</span></div>
          <div class="form-grid">
            <label v-if="!['spots','series','peripherals','addonServices','stories','cities'].includes(state.editContent.__key)"><span>关联打卡点<em class="field-opt">可选</em></span><el-select v-model="state.editContent.spotId" clearable filterable placeholder="关联打卡点（可选 · 不绑定也能创建）"><el-option v-for="s in data.spots" :key="s.id" :label="s.name" :value="s.id" /></el-select></label>
            <label v-if="['packages'].includes(state.editContent.__key)"><span>关联打卡点(多)</span><el-select v-model="state.editContent.spotIds" multiple filterable placeholder="可多选打卡点"><el-option v-for="s in data.spots" :key="s.id" :label="s.name" :value="s.id" /></el-select></label>
            <label v-if="['albums','samples','packages','guides'].includes(state.editContent.__key)"><span>关联拍摄风格</span><el-select v-model="state.editContent.seriesId" clearable filterable placeholder="关联拍摄风格"><el-option v-for="s in data.series.filter(i=>!state.editContent.spotId || i.spotId===state.editContent.spotId || (i.spotIds||[]).includes(state.editContent.spotId))" :key="s.id" :label="s.name" :value="s.id" /></el-select></label>
            <label v-if="['samples','packages'].includes(state.editContent.__key)"><span>关联照片单品</span><el-select v-model="state.editContent.albumId" clearable filterable placeholder="关联照片单品"><el-option v-for="a in data.albums.filter(i=>!state.editContent.seriesId || i.seriesId===state.editContent.seriesId)" :key="a.id" :label="a.name" :value="a.id" /></el-select></label>
          </div>
        </div>
        <div v-if="state.editContent.__key==='spots'" class="content-form-section">
          <div class="content-form-section-head"><strong>点位资料</strong><span>地址、风格、标签与热度用于小程序打卡点详情页与首页排序展示。</span></div>
          <div class="form-grid">
            <label><span>详细地址</span><el-input v-model="state.editContent.address" placeholder="如 长沙市天心区湘江中路" /></label>
            <label><span>热度分</span><el-input-number v-model="state.editContent.hotScore" :min="0" :max="10" :step="0.1" /></label>
            <label><span>打卡人数</span><el-input-number v-model="state.editContent.checkinCount" :min="0" /></label>
            <label><span>风格标签</span><el-select v-model="state.editContent.styles" multiple filterable allow-create placeholder="如 国风/江景/夜景"><el-option v-for="t in tagOptions()" :key="t.id" :label="t.name" :value="t.name" /></el-select></label>
            <label><span>内容标签</span><el-select v-model="state.editContent.tags" multiple filterable allow-create placeholder="如 江景/古建"><el-option v-for="t in tagOptions()" :key="t.id" :label="t.name" :value="t.name" /></el-select></label>
            <label class="switch-line"><span>小程序展示</span><el-switch v-model="state.editContent.isShow" active-text="展示" inactive-text="隐藏" /></label>
          </div>
          <el-input v-model="state.editContent.description" type="textarea" :rows="3" placeholder="点位介绍 / 出片说明（小程序详情页正文）" />
        </div>
        <div v-if="state.editContent.__key==='series'" class="content-form-section">
          <div class="content-form-section-head"><strong>拍摄风格资料</strong><span>风格、商品类型与价格区间用于小程序风格详情页与筛选。</span></div>
          <div class="form-grid">
            <label><span>商品类型</span><el-select v-model="state.editContent.productType" clearable placeholder="商品类型"><el-option label="拍照类" value="photo" /><el-option label="短视频类" value="video" /></el-select></label>
            <label><span>风格标签</span><el-select v-model="state.editContent.styles" multiple filterable allow-create placeholder="风格"><el-option v-for="t in tagOptions()" :key="t.id" :label="t.name" :value="t.name" /></el-select></label>
            <label><span>内容标签</span><el-select v-model="state.editContent.tags" multiple filterable allow-create placeholder="标签"><el-option v-for="t in tagOptions()" :key="t.id" :label="t.name" :value="t.name" /></el-select></label>
            <label><span>已售数量</span><el-input-number v-model="state.editContent.soldCount" :min="0" /></label>
            <label><span>最低价</span><el-input-number v-model="state.editContent.minPrice" :min="0" /></label>
            <label><span>最高价</span><el-input-number v-model="state.editContent.maxPrice" :min="0" /></label>
            <label><span>关联打卡点</span><el-select v-model="state.editContent.spotIds" multiple filterable placeholder="可多选打卡点"><el-option v-for="s in data.spots" :key="s.id" :label="s.name" :value="s.id" /></el-select></label>
            <label><span>关联套餐</span><el-select v-model="state.editContent.packageIds" multiple filterable placeholder="关联套餐"><el-option v-for="p in data.packages" :key="p.id" :label="p.name" :value="p.id" /></el-select></label>
          </div>
        </div>
        <div v-if="state.editContent.__key==='albums'" class="content-form-section">
          <div class="content-form-section-head"><strong>照片单品资料</strong><span>样片数量与拍摄说明用于小程序照片单品详情页。</span></div>
          <div class="form-grid">
            <label><span>样片数量</span><el-input-number v-model="state.editContent.photoCount" :min="0" /></label>
          </div>
          <el-input v-model="state.editContent.shootingNotes" type="textarea" :rows="2" placeholder="拍摄说明 / 出片建议（小程序照片单品详情页展示）" />
          <p class="upload-tip">素材图（sampleUrls）由「素材库」页按照片单品归属自动归集，无需在此逐项填写。</p>
        </div>
        <div v-if="state.editContent.__key==='guides'" class="content-form-section">
          <div class="content-form-section-head"><strong>攻略资料</strong><span>标题、关联套餐与热度用于小程序攻略详情页与列表展示。</span></div>
          <div class="form-grid">
            <label><span>攻略标题</span><el-input v-model="state.editContent.title" placeholder="攻略标题（小程序展示标题）" /></label>
            <label><span>关联套餐</span><el-select v-model="state.editContent.targetPackageId" clearable filterable placeholder="关联拍摄套餐"><el-option v-for="p in data.packages" :key="p.id" :label="p.name" :value="p.id" /></el-select></label>
            <label class="switch-line"><span>首页热推</span><el-switch v-model="state.editContent.isHot" active-text="首页热推攻略" /></label>
            <label><span>阅读数</span><el-input-number v-model="state.editContent.readCount" :min="0" /></label>
            <label><span>评分</span><el-input v-model="state.editContent.score" placeholder="如 4.9" /></label>
          </div>
        </div>
        <div v-if="state.editContent.__key==='cities'" class="content-form-section">
          <div class="content-form-section-head"><strong>城市配置</strong><span>运营模式与上线状态决定小程序城市切换器是否对该城市开放（需配合小程序多城能力）。</span></div>
          <div class="form-grid">
            <label><span>运营模式</span><el-select v-model="state.editContent.mode" clearable placeholder="运营模式"><el-option label="直营" value="直营" /><el-option label="加盟" value="加盟" /></el-select></label>
            <label><span>上线状态</span><el-select v-model="state.editContent.status" clearable placeholder="上线状态"><el-option label="运营中" value="运营中" /><el-option label="筹备中" value="筹备中" /></el-select></label>
          </div>
          <el-input v-model="state.editContent.description" type="textarea" :rows="2" placeholder="城市简介（可选，用于小程序城市介绍与运营备注）" />
        </div>
        <div v-if="['albums','packages','peripherals','addonServices'].includes(state.editContent.__key)" class="content-form-section">
          <div class="content-form-section-head"><strong>价格与货架</strong><span>公开售卖商品会进入审核、上下架和小程序可见性规则。</span></div>
          <div class="form-grid">
            <label v-if="['albums','packages'].includes(state.editContent.__key)"><span>原价</span><el-input-number v-model="state.editContent.originalPrice" :min="0" placeholder="原价" /></label>
            <label><span>售价</span><el-input-number v-model="state.editContent.price" :min="0" placeholder="售价" /></label>
          </div>
        </div>
        <div v-if="['packages','albums','peripherals','addonServices'].includes(state.editContent.__key)" class="content-form-section advanced-section">
          <div class="content-form-section-head"><strong>高级/可选设置</strong><span>非必填字段默认收拢在同一业务分组，便于运营按商品类型逐项配置。</span></div>
          <div v-if="state.editContent.__key==='packages'" class="package-edit-block">
          <div class="section-title-row compact"><h3>套餐专项配置</h3><span class="muted">拍照与短视频字段动态区分，均只用于商品运营配置。</span></div>
          <div class="form-grid">
            <label><span>日常活动价</span><el-input-number v-model="state.editContent.specialPrice" :min="0" /></label>
            <label><span>定金比例(%)</span><el-input-number v-model="state.editContent.depositRatio" :min="0" :max="100" /></label>
            <label><span>尾款结算规则</span><el-input v-model="state.editContent.finalPaymentRule" placeholder="尾款结算规则" /></label>
            <label><span>工作日特价</span><el-input-number v-model="state.editContent.weekdayPrice" :min="0" /></label>
            <label><span>周末加价</span><el-input-number v-model="state.editContent.weekendSurcharge" :min="0" /></label>
            <label><span>节假日溢价</span><el-input-number v-model="state.editContent.holidaySurcharge" :min="0" /></label>
            <label v-if="state.editContent.type!=='video'"><span>拍摄时长(分钟)</span><el-input-number v-model="state.editContent.duration" :min="0" /></label>
            <label v-if="state.editContent.type!=='video'"><span>精修张数</span><el-input-number v-model="state.editContent.retouchCount" :min="0" /></label>
            <label v-if="state.editContent.type==='video'" class="full-width"><span>产品形态</span><el-select v-model="state.editContent.productKind" clearable placeholder="短视频（统一为单品）"><el-option label="短视频" value="video_single" /></el-select></label>
            <label v-if="state.editContent.type==='video' && state.editContent.productKind==='video_single'"><span>视频地址</span><el-input v-model="state.editContent.videoUrl" placeholder="视频播放地址 URL" /></label>
            <label v-if="state.editContent.type==='video' && state.editContent.productKind==='video_single'"><span>预览地址</span><el-input v-model="state.editContent.previewVideoUrl" placeholder="预览视频地址 URL" /></label>
            <label v-if="state.editContent.type==='video'"><span>视频时长(秒)</span><el-input-number v-model="state.editContent.videoDuration" :min="0" /></label>
            <label v-if="state.editContent.type==='video'"><span>成片条数</span><el-input-number v-model="state.editContent.finishedVideoCount" :min="0" /></label>
            <label v-if="state.editContent.type==='video'" class="switch-line"><span>支持航拍</span><el-switch v-model="state.editContent.hasAerial" /></label>
            <label v-if="state.editContent.type==='video'" class="switch-line"><span>全包剪辑</span><el-switch v-model="state.editContent.fullEdit" /></label>
            <label v-if="state.editContent.type==='video'"><span>航拍附加加价</span><el-input-number v-model="state.editContent.aerialExtraPrice" :min="0" /></label>
            <label v-if="state.editContent.type==='video'"><span>赠送项</span><el-select v-model="state.editContent.giftItems" multiple filterable allow-create placeholder="如 封面图1张/文案建议"><el-option v-for="g in ['短视频封面图1张','发布文案建议','花絮截图6张','15秒预告剪辑1条']" :key="g" :label="g" :value="g" /></el-select></label>
            <label><span>交付周期</span><el-input v-model="state.editContent.deliveryCycle" placeholder="交付周期" /></label>
            <label><span>日预约上限</span><el-input-number v-model="state.editContent.bookingLimit" :min="0" /></label>
            <label><span>提前预约天数</span><el-input-number v-model="state.editContent.advanceBookingDays" :min="0" /></label>
            <label><span>节假日配额</span><el-input-number v-model="state.editContent.holidayQuota" :min="0" /></label>
            <label v-if="state.editContent.type==='video'"><span>分时段限流</span><el-input-number v-model="state.editContent.timeSlotLimit" :min="0" /></label>
          </div>
          <div class="included-items-editor">
            <div class="section-title-row compact"><h3>套餐包含</h3><span class="muted">小程序详情页「套餐包含」展示；可选照片单品 / 短视频 / 周边，保存后游客可在小程序点开查看。</span></div>
            <div v-for="(it, idx) in (state.editContent.includedItems || [])" :key="idx" class="included-item-row">
              <el-select v-model="it.type" placeholder="类型" style="width:120px"><el-option label="照片单品" value="album" /><el-option label="短视频" value="video" /><el-option label="周边" value="peripheral" /></el-select>
              <el-input v-model="it.name" placeholder="名称（如 杜甫江阁夜景照片单品）" style="flex:1" />
              <el-input v-model="it.price" placeholder="价格" style="width:90px" />
              <el-button size="small" type="danger" plain @click="state.editContent.includedItems.splice(idx,1)">删</el-button>
            </div>
            <el-button size="small" @click="addIncludedItem()">+ 添加包含项</el-button>
            <p class="upload-tip">保存时自动补齐小程序所需跳转参数（target）；关联照片单品/周边时按名称匹配，未匹配则不带跳转。</p>
          </div>
          <el-select class="section-gap" v-model="state.editContent.mutualExclusionIds" multiple filterable placeholder="选择互斥套餐，冲突商品不可同时下单">
            <el-option v-for="p in data.packages.filter(i=>i.id!==state.editContent.id)" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
          <el-select class="section-gap" v-model="state.editContent.serviceTags" multiple filterable allow-create placeholder="选择服务/风格/人群标签">
            <el-option v-for="t in tagOptions()" :key="t.id" :label="t.name + ' · ' + t.category" :value="t.name" />
          </el-select>
          </div>
          <div v-if="state.editContent.__key==='albums'" class="package-edit-block">
          <div class="section-title-row compact"><h3>照片单品售卖与素材展示</h3><span class="muted">售卖下架不影响素材引用；素材展示关闭后套餐不应再引用该照片单品素材。</span></div>
          <div class="form-grid">
            <el-switch v-model="state.editContent.isSellable" active-text="允许作为商品售卖" />
            <el-switch v-model="state.editContent.allowMaterialUse" active-text="允许套餐引用素材" />
            <el-switch v-model="state.editContent.photoMaterialEnabled" active-text="图片样片可用" />
            <el-switch v-model="state.editContent.videoMaterialEnabled" active-text="视频样片可用" />
          </div>
          <el-select class="section-gap" v-model="state.editContent.tags" multiple filterable allow-create placeholder="选择照片单品风格/场景/人群标签">
            <el-option v-for="t in tagOptions()" :key="t.id" :label="t.name + ' · ' + t.category" :value="t.name" />
          </el-select>
          </div>
          <div v-if="state.editContent.__key==='peripherals'" class="package-edit-block">
          <div class="section-title-row compact"><h3>周边商品配置</h3><span class="muted">周边是实物商品，可设置定点专属或全城通用。</span></div>
          <div class="form-grid">
            <label><span>关联模式</span><el-select v-model="state.editContent.mode" placeholder="关联模式"><el-option label="定点专属" value="定点专属" /><el-option label="全城通用" value="全城通用" /></el-select></label>
            <label v-if="state.editContent.mode!=='全城通用'"><span>专属打卡点</span><el-select v-model="state.editContent.spotId" clearable filterable placeholder="专属打卡点"><el-option v-for="s in data.spots" :key="s.id" :label="s.name" :value="s.id" /></el-select></label>
            <label><span>商品规格</span><el-select v-model="state.editContent.specs" multiple filterable allow-create placeholder="可多选/可新建，如 A4/A5、硬壳、皮面"><el-option v-for="s in ['A4/A5','硬壳','皮面','实木','立式','哑光','亮面','磁性','定制图','UV打印','LED','水晶','悬浮']" :key="s" :label="s" :value="s" /></el-select></label>
            <label><span>库存数量</span><el-input-number v-model="state.editContent.stock" :min="0" /></label>
            <label class="switch-line"><span>热卖标记</span><el-switch v-model="state.editContent.isHot" active-text="小程序展示热卖" /></label>
            <label class="switch-line"><span>新品标记</span><el-switch v-model="state.editContent.isNew" active-text="小程序展示新品" /></label>
            <label><span>发货周期</span><el-input v-model="state.editContent.deliveryCycle" placeholder="发货周期" /></label>
            <label><span>定时上架时间</span><el-input v-model="state.editContent.scheduledOnAt" placeholder="定时上架时间" /></label>
            <label><span>定时下架时间</span><el-input v-model="state.editContent.scheduledOffAt" placeholder="定时下架时间" /></label>
            <label><span>审核状态</span><el-select v-model="state.editContent.auditStatus" placeholder="审核状态"><el-option label="已上架" value="已上架" /><el-option label="待审核" value="待审核" /><el-option label="草稿" value="草稿" /><el-option label="已下架" value="已下架" /></el-select></label>
          </div>
          </div>
          <div v-if="state.editContent.__key==='addonServices'" class="package-edit-block">
          <div class="section-title-row compact"><h3>增值服务规则</h3><span class="muted">仅客服订单加购使用，小程序商城不展示。</span></div>
          <div class="form-grid">
            <el-select v-model="state.editContent.eligibility" placeholder="订单适用范围"><el-option label="全订单通用" value="all" /><el-option label="仅拍照订单" value="photo" /><el-option label="仅短视频订单" value="video" /></el-select>
            <el-input-number v-model="state.editContent.maxQuantity" :min="1" placeholder="单订单最大购买份数" />
            <el-input-number v-model="state.editContent.holidaySurcharge" :min="0" placeholder="节假日加价" />
            <el-switch v-model="state.editContent.financeReviewRequired" active-text="需要财务审核" />
            <el-switch v-model="state.editContent.includeInOrderAmount" active-text="计入订单总额" />
          </div>
          <el-select class="section-gap" v-model="state.editContent.defaultForPackageIds" multiple filterable placeholder="套餐默认勾选此增值服务">
            <el-option v-for="p in data.packages" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
          </div>
        </div>
        <div class="content-form-section">
          <div class="content-form-section-head"><strong>详情与素材</strong><span>说明文案和封面统一放在底部；封面支持本地上传或图片链接，保存后立即生效（演示环境仅存于本地预览）。</span></div>
          <el-input v-model="state.editContent[['packages','guides'].includes(state.editContent.__key) ? 'description' : 'intro']" type="textarea" :rows="3" :placeholder="['packages','guides'].includes(state.editContent.__key) ? '详情说明（写入小程序 description 字段）' : '简介/详情说明'" />
          <div class="upload-block">
            <div class="upload-thumb">
              <img v-if="state.editContent.cover || state.editContent.url" :src="state.editContent.cover || state.editContent.url" />
              <div v-else class="upload-empty">暂无封面</div>
            </div>
            <div class="upload-actions">
              <label class="upload-btn">选择本地图片<input type="file" accept="image/*" hidden @change="uploadContentCover" /></label>
              <el-input size="small" placeholder="或粘贴图片链接 URL" :model-value="(state.editContent.cover || state.editContent.url || '')" @input="applyCoverUrl" />
              <p class="upload-tip">支持本地图片（≤2MB）或图片链接；封面仅本地预览，正式环境接入对象存储后自动上传。</p>
            </div>
          </div>
        </div>
      </div>
      <template #footer><el-button @click="state.contentDialog=false">取消</el-button><el-button type="primary" @click="saveContent">保存</el-button></template>
    </el-dialog>
  </div>`
};

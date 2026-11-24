"use strict";

const { localTime, timestamp, failure } = require("./svcBenefit.cjs");

// External calls run after onboarding commits and outside the accounting lock.
// A durable lease serializes retries across processes; an expired lease can be
// reclaimed after a crash. The provider uses a stable member ID on retries.
function createSvcWecomSync({ store, contacts, clock = () => new Date() }) {
  async function run(staffId) {
    const claim = await store.transaction(state => {
      const row = state.staff.find(person => String(person.id) === String(staffId));
      if (!row) throw failure(4014, "客服档案不存在");
      if (row.staff_status === "ended") throw failure(4014, "已终止客服不能同步企业微信");
      if (row.wecom_sync_status === "synced") return { row };
      const at = localTime(clock());
      if (row.wecom_sync_status === "syncing" && row.wecom_sync_started_at && timestamp(at) - timestamp(row.wecom_sync_started_at) < 300000) return { row };
      if (!contacts.enabled) {
        Object.assign(row, { wecom_sync_status: "disabled", wecom_sync_message: "企业微信自动邀请尚未启用，请配置后重试同步" });
        return { row };
      }
      Object.assign(row, { wecom_sync_status: "syncing", wecom_sync_started_at: at, wecom_sync_message: "正在同步企业微信" });
      return { row: { ...row }, started: at };
    });
    if (!claim.started) return claim.row;
    let member;
    try {
      member = await contacts.ensureMember({ staffId: claim.row.id, name: claim.row.name, phone: claim.row.phone, userid: claim.row.wecom_userid || undefined });
      return await store.transaction(async (state, conn) => {
        const row = state.staff.find(person => String(person.id) === String(staffId));
        if (row.wecom_sync_started_at !== claim.started || row.wecom_sync_status !== "syncing") return row;
        // Sharing links use the login account ID, rather than the service profile
        // ID. Never overwrite a member already mapped to a different account.
        if (conn && row.account_id) {
          const [mappings] = await conn.query("SELECT wecom_userid,staff_id,status FROM lxm_share_staff_map WHERE wecom_userid=? OR staff_id=? FOR UPDATE", [member.userid, row.account_id]);
          if (mappings.some(map => String(map.wecom_userid) === member.userid && String(map.staff_id) !== String(row.account_id) || String(map.staff_id) === String(row.account_id) && String(map.wecom_userid) !== member.userid)) {
            throw Object.assign(new Error("企微映射冲突"), { userMessage: "企微成员或后台账号已绑定其他客服，请核对映射后重试" });
          }
          if (mappings.length) await conn.query("UPDATE lxm_share_staff_map SET status='ACTIVE' WHERE wecom_userid=? AND staff_id=?", [member.userid, row.account_id]);
          else await conn.query("INSERT INTO lxm_share_staff_map (wecom_userid,staff_id,status,created_at) VALUES (?,?,'ACTIVE',?)", [member.userid, row.account_id, localTime(clock())]);
        }
        Object.assign(row, { wecom_userid: member.userid, wecom_department_id: member.departmentId, wecom_sync_status: "synced", wecom_synced_at: localTime(clock()),
          wecom_sync_message: member.invitationStatus === "active" ? "已加入企业微信客服部门" : "已加入企业微信客服部门，邀请已提交，待成员确认加入" });
        return row;
      });
    } catch (error) {
      return store.transaction(state => {
        const row = state.staff.find(person => String(person.id) === String(staffId));
        if (row.wecom_sync_started_at !== claim.started || row.wecom_sync_status !== "syncing") return row;
        const userid = member?.userid || error.userid;
        if (typeof userid === "string" && /^[A-Za-z0-9_@.\-]{1,128}$/.test(userid)) row.wecom_userid = userid;
        Object.assign(row, { wecom_sync_status: "failed", wecom_sync_message: String(error.userMessage || "企微同步暂未完成，请重试；若持续失败，请检查通讯录权限和服务器网络").slice(0, 255) });
        return row;
      });
    }
  }
  return { run };
}

module.exports = { createSvcWecomSync };

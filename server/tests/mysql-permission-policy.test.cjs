"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const mysql = require("mysql2/promise");

require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env"), quiet: true });

const createApi = require("../lib/api.cjs");
const { createAuthStore } = require("../lib/auth.cjs");
const createPermissionStore = require("../lib/permissionStore.cjs");
const selectSource = require("../lib/selectSource.cjs");

const RUN_MYSQL_TESTS = process.env.LXM_TEST_MYSQL === "1";

function databaseConfig() {
  return {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || ""
  };
}

function makeSource() {
  const collections = new Map();
  const rows = (key) => {
    if (!collections.has(key)) collections.set(key, new Map());
    return collections.get(key);
  };
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  return {
    backend: "mysql",
    async list(key) { return [...rows(key).values()].map(clone); },
    async get(key, id) { return clone(rows(key).get(String(id)) || null); },
    async create(key, value) {
      const id = String(value.id || value._id || crypto.randomUUID());
      const next = { ...value, id, _id: id };
      rows(key).set(id, next);
      return clone(next);
    },
    async update(key, id, patch) {
      const current = rows(key).get(String(id));
      if (!current) return null;
      const next = { ...current, ...patch, id: String(id), _id: String(id) };
      rows(key).set(String(id), next);
      return clone(next);
    },
    async remove(key, id) { return rows(key).delete(String(id)); },
    async health() { return { backend: "mysql", ready: true, persistent: true }; }
  };
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
}

test("runtime source selection does not fall back to JSON", () => {
  const previous = Object.fromEntries(["NODE_ENV", "DATA_MODE", "LXM_ALLOW_TEST_JSON_SOURCE", "DB_HOST", "DB_USER", "DB_NAME"].map((key) => [key, process.env[key]]));
  try {
    process.env.NODE_ENV = "development";
    process.env.DATA_MODE = "json";
    delete process.env.LXM_ALLOW_TEST_JSON_SOURCE;
    delete process.env.DB_HOST;
    delete process.env.DB_USER;
    delete process.env.DB_NAME;
    const selected = selectSource();
    assert.equal(selected.mode, "mysql");
    assert.equal(selected.source.backend, "mysql");
    assert.equal(selected.status.ready, false);
    assert.equal(selected.status.error, "mysql_config_missing");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("menu policy closes active parents and ignores legacy action grants", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lxm-menu-policy-"));
  const file = path.join(dir, "authz.json");
  const now = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({
    collections: {},
    authz: {
      menus: {
        root: { id: "root", menuKey: "root", name: "Root", status: "active", createdAt: now, updatedAt: now },
        child: { id: "child", menuKey: "child", parentKey: "root", name: "Child", status: "active", createdAt: now, updatedAt: now },
        grandchild: { id: "grandchild", menuKey: "grandchild", parentKey: "child", name: "Grandchild", status: "active", createdAt: now, updatedAt: now },
        disabled: { id: "disabled", menuKey: "disabled", name: "Disabled", status: "disabled", createdAt: now, updatedAt: now }
      },
      roles: {
        role_member: { id: "role_member", roleKey: "member", name: "Member", status: "active", createdAt: now, updatedAt: now }
      },
      roleMenus: {
        role_member: { roleId: "role_member", menuIds: ["child", "grandchild", "disabled"], updatedAt: now }
      },
      rolePermissions: {
        role_member: { roleId: "role_member", permissions: ["orderEdit"], updatedAt: now }
      },
      users: {
        user_member: { id: "user_member", account: "member", name: "Member", roleId: "role_member", role: "member", status: "active", permissionKeys: ["orderEdit"], createdAt: now, updatedAt: now }
      }
    }
  }), "utf8");

  const store = createPermissionStore({ backend: "json", jsonFile: file });
  try {
    const policy = await store.getPolicyForUser(await store.getUser("user_member"));
    assert.deepEqual(policy.menuKeys, ["child"]);
    assert.equal(Object.prototype.hasOwnProperty.call(policy, "permissionKeys"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(policy.user || {}, "permissionKeys"), false);
    assert.deepEqual(await store.getRoleGrants("role_member"), { roleId: "role_member", menuKeys: ["child", "grandchild", "disabled"] });
    await store.updateMenu("child", { parentKey: null, parentId: "root" });
    const detached = await store.getMenu("child");
    assert.equal(detached.parentKey, null);
    assert.equal(detached.parentId, null);
    await store.updateMenu("child", { parentId: "root" });
    const reattached = await store.getMenu("child");
    assert.equal(reattached.parentKey, "root");
    assert.equal(reattached.parentId, "root");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(raw.authz.rolePermissions.role_member.permissions, ["orderEdit"]);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MySQL admin policy is automatic and password changes require admin", { skip: !RUN_MYSQL_TESTS }, async () => {
  const config = databaseConfig();
  const database = `codex_permission_policy_${process.pid}_${Date.now()}`;
  const admin = await mysql.createConnection(config);
  let store;
  let auth;
  let server;

  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    store = createPermissionStore({ backend: "mysql", dbHost: config.host, dbPort: config.port, dbUser: config.user, dbPassword: config.password, dbName: database, autoMigrate: true });
    await store.init();

    await store.createMenu({ id: "menu_root", menuKey: "root", name: "Root", path: "/dashboard", status: "active", meta: { routeKey: "dashboard" } });
    await store.createMenu({ id: "menu_child", menuKey: "child", parentKey: "root", name: "Child", path: "/orders", status: "active", meta: { routeKey: "orders" } });
    await store.updateMenu("menu_child", { parentKey: null, parentId: "root" });
    assert.equal((await store.getMenu("menu_child")).parentKey, null);
    assert.equal((await store.getMenu("menu_child")).parentId, null);
    await store.updateMenu("menu_child", { parentId: "menu_root" });
    assert.equal((await store.getMenu("menu_child")).parentKey, "root");
    assert.equal((await store.getMenu("menu_child")).parentId, "root");
    await assert.rejects(
      () => store.updateMenu("menu_root", { parentKey: "root" }),
      (error) => error && error.code === "MENU_DEPTH_INVALID"
    );
    await assert.rejects(
      () => store.createMenu({ id: "menu_grandchild", menuKey: "grandchild", parentKey: "child", name: "Grandchild", path: "/orders", status: "active", meta: { routeKey: "orders" } }),
      (error) => error && error.code === "MENU_DEPTH_INVALID"
    );

    await store.createRole({ id: "role_super", roleKey: "super", name: "System", status: "active" });
    await store.createRole({ id: "role_member", roleKey: "member", name: "Member", status: "active" });
    await store.createUser({ id: "user_admin", account: "admin", name: "Admin", password: "AdminPass123", roleId: "role_super", role: "super", status: "active", extra: { legacyKey: "staff", legacyId: "user_admin", subjectType: "staff", subjectId: "user_admin" } });
    await store.createUser({ id: "user_peer", account: "super_peer", name: "Peer", password: "PeerPass123", roleId: "role_super", role: "super", status: "active", extra: { legacyKey: "staff", legacyId: "user_peer", subjectType: "staff", subjectId: "user_peer" } });
    await store.createUser({ id: "user_member", account: "member", name: "Member", password: "MemberPass123", roleId: "role_member", role: "member", status: "active", extra: { legacyKey: "staff", legacyId: "user_member", subjectType: "staff", subjectId: "user_member" } });

    const beforePolicy = await store.getPolicyForUser(await store.getUser("user_admin"));
    assert.deepEqual(new Set(beforePolicy.menuKeys), new Set(["root", "child"]));
    assert.equal(Object.prototype.hasOwnProperty.call(beforePolicy, "permissionKeys"), false);
    assert.deepEqual(await store.getRoleGrants("role_super"), { roleId: "role_super", menuKeys: [] });

    await store.createMenu({ id: "menu_new", menuKey: "new", name: "New", path: "/orders", status: "active", meta: { routeKey: "orders" } });
    const afterPolicy = await store.getPolicyForUser(await store.getUser("user_admin"));
    assert.ok(afterPolicy.menuKeys.includes("new"));

    // A separate super account is allowed to reach the management route, but
    // it must not change another person's password.
    await store.setRoleGrants("role_super", { menuKeys: ["root"], permissionKeys: ["*"] });
    auth = createAuthStore();
    const handler = createApi(makeSource(), "mysql", { auth, permissionStore: store, sourceStatus: { configured: true, ready: true, persistent: true } });
    server = http.createServer((req, res) => handler(req, res, (req.url || "/").split("?")[0]));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = async (account, password) => {
      const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account, password }) });
      return { status: response.status, body: await response.json() };
    };
    const updatePassword = async (token, password) => {
      const response = await fetch(`${base}/api/permissions/users/user_member`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ password }) });
      return { status: response.status, body: await response.json() };
    };

    const adminLogin = await login("admin", "AdminPass123");
    assert.equal(adminLogin.status, 200);
    assert.ok(adminLogin.body.menus.includes("new"));
    assert.equal(Object.prototype.hasOwnProperty.call(adminLogin.body, "permissions"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(adminLogin.body, "permissionKeys"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(adminLogin.body, "actions"), false);
    assert.equal(adminLogin.body.menuDefinitions.find((menu) => menu.key === "child").parentKey, "root");
    const meResponse = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${adminLogin.body.token}` } });
    const me = await meResponse.json();
    assert.equal(meResponse.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(me, "permissions"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(me, "permissionKeys"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(me, "actions"), false);

    const rolesResponse = await fetch(`${base}/api/permissions/roles`, { headers: { Authorization: `Bearer ${adminLogin.body.token}` } });
    const roles = await rolesResponse.json();
    const superRole = roles.find((role) => role.roleKey === "super");
    assert.ok(superRole.menus.includes("new"));
    assert.equal(Object.prototype.hasOwnProperty.call(superRole, "permissionKeys"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(superRole, "actions"), false);
    const protectedGrant = await fetch(`${base}/api/permissions/roles/role_super/grants`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminLogin.body.token}` }, body: JSON.stringify({ menuKeys: [], permissionKeys: [] }) });
    assert.equal(protectedGrant.status, 403);

    await admin.query(`INSERT INTO \`${database}\`.lxm_auth_role_permissions (role_id,permission_key) VALUES (?,?)`, ["role_member", "orderEdit"]);
    await admin.query(`INSERT INTO \`${database}\`.lxm_auth_user_permissions (user_id,permission_key) VALUES (?,?)`, ["user_member", "orderEdit"]);
    const memberGrant = await fetch(`${base}/api/permissions/roles/role_member/grants`, {
      method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminLogin.body.token}` },
      body: JSON.stringify({ menuKeys: ["child"], permissionKeys: ["financeReview"], actions: ["financeReview"] })
    });
    const memberGrantBody = await memberGrant.json();
    assert.equal(memberGrant.status, 200);
    assert.deepEqual(memberGrantBody.menuKeys, ["child"]);
    assert.equal(Object.prototype.hasOwnProperty.call(memberGrantBody, "permissionKeys"), false);
    const memberLogin = await login("member", "MemberPass123");
    assert.equal(memberLogin.status, 200);
    assert.deepEqual(new Set(memberLogin.body.menuKeys), new Set(["child"]));
    assert.equal(memberLogin.body.menuDefinitions.every((menu) => ["root", "child"].includes(menu.key)), true);
    assert.equal(memberLogin.body.menuDefinitions.find((menu) => menu.key === "root").containerOnly, true);
    assert.equal(memberLogin.body.menuDefinitions.find((menu) => menu.key === "child").containerOnly, false);
    const memberUpdate = await fetch(`${base}/api/permissions/users/user_member`, {
      method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminLogin.body.token}` },
      body: JSON.stringify({ permissionKeys: ["financeReview"], permissions: ["financeReview"] })
    });
    const memberUpdateBody = await memberUpdate.json();
    assert.equal(memberUpdate.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(memberUpdateBody, "permissionKeys"), false);
    const [legacyRoleRows] = await admin.query(`SELECT permission_key FROM \`${database}\`.lxm_auth_role_permissions WHERE role_id=?`, ["role_member"]);
    const [legacyUserRows] = await admin.query(`SELECT permission_key FROM \`${database}\`.lxm_auth_user_permissions WHERE user_id=?`, ["user_member"]);
    assert.deepEqual(legacyRoleRows.map((row) => row.permission_key), ["orderEdit"]);
    assert.deepEqual(legacyUserRows.map((row) => row.permission_key), ["orderEdit"]);

    const peerLogin = await login("super_peer", "PeerPass123");
    assert.equal(peerLogin.status, 200);
    assert.equal((await updatePassword(peerLogin.body.token, "BlockedPass123")).status, 403);
    assert.equal((await updatePassword(adminLogin.body.token, "UpdatedPass123")).status, 200);
    assert.ok(await store.authenticate("member", "UpdatedPass123"));
  } finally {
    await closeServer(server);
    if (auth) await auth.close();
    if (store) await store.close();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
});

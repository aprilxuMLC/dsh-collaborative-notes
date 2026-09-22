// Vitest 配置：运行公开客户端状态机与本地化测试。
//（宿主测试 notes-api.test.mjs 等仍用 node 直接跑，不纳入 vitest）
export default {
  test: {
    include: ["test/client-state.test.mjs", "test/locales.test.mjs"],
    environment: "happy-dom",
  },
};

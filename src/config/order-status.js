// 订单状态配置：内部流转状态和客户可见文案。
const ORDER_FLOW = [
  "deposit_paid",
  "assigned",
  "shooting",
  "delivered",
  "final_pending",
  "completed"
];

const statusMap = {
  reserved: { text: "已预约", customer: "已预约", className: "paid" },
  awaiting_shoot: { text: "待拍摄", customer: "待拍摄", className: "assigned" },
  deposit_paid: { text: "已预约", customer: "已预约", className: "paid" },
  assigned: { text: "待拍摄", customer: "待拍摄", className: "assigned" },
  shooting: { text: "拍摄中", customer: "拍摄中", className: "shooting" },
  delivered: { text: "已预约", customer: "已预约", className: "delivered" },
  final_pending: { text: "已预约", customer: "已预约", className: "final" },
  paid: { text: "已完成", customer: "已完成", className: "paid" },
  completed: { text: "已完成", customer: "已完成", className: "completed" },
  canceled: { text: "已取消", customer: "订单已取消", className: "canceled" }
};

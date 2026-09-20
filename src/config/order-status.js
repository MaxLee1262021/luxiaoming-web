// 订单状态配置：内部流转状态和客户可见文案。
const ORDER_FLOW = [
  "new",
  "contacted",
  "confirmed",
  "deposit_pending",
  "deposit_paid",
  "assigned",
  "shooting",
  "delivered",
  "final_pending",
  "completed"
];

const statusMap = {
  new: { text: "待支付", customer: "待支付", className: "pending" },
  contacted: { text: "待支付", customer: "待支付", className: "pending" },
  confirmed: { text: "待支付", customer: "待支付", className: "deposit" },
  deposit_pending: { text: "待支付", customer: "待支付", className: "deposit" },
  deposit_paid: { text: "待安排摄影师", customer: "待安排摄影师", className: "paid" },
  assigned: { text: "待安排摄影师", customer: "待安排摄影师", className: "assigned" },
  shooting: { text: "待安排摄影师", customer: "待安排摄影师", className: "shooting" },
  delivered: { text: "已交付", customer: "已交付", className: "delivered" },
  final_pending: { text: "已拍摄", customer: "已拍摄", className: "final" },
  paid: { text: "已支付", customer: "已支付", className: "paid" },
  completed: { text: "已交付", customer: "已交付", className: "completed" },
  canceled: { text: "已取消", customer: "订单已取消", className: "canceled" }
};

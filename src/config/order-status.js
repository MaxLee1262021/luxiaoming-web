// 订单状态配置：内部流转状态和客户可见文案。
const ORDER_FLOW = [
  "new",
  "contacted",
  "deposit_pending",
  "deposit_paid",
  "assigned",
  "shooting",
  "delivered",
  "final_pending",
  "completed"
];

const statusMap = {
  new: { text: "待联系", customer: "预约已提交，等待客服确认", className: "pending" },
  contacted: { text: "已联系", customer: "客服已联系，等待确认定金", className: "contacted" },
  deposit_pending: { text: "待定金", customer: "待支付定金", className: "deposit" },
  deposit_paid: { text: "已付定金", customer: "定金已确认，等待安排摄影师", className: "paid" },
  assigned: { text: "已派单", customer: "摄影师已安排，等待拍摄", className: "assigned" },
  shooting: { text: "拍摄中", customer: "正在拍摄服务中", className: "shooting" },
  delivered: { text: "已交付", customer: "成片已通过微信发送，请确认尾款", className: "delivered" },
  final_pending: { text: "待尾款", customer: "待支付尾款", className: "final" },
  completed: { text: "已完成", customer: "订单已完成，感谢选择鹿小鸣", className: "completed" },
  canceled: { text: "已取消", customer: "订单已取消", className: "canceled" }
};

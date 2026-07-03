const secret = process.env.ARCOVIA_FLOW_SECRET || "change-me-long-random-secret";

const response = await fetch("http://localhost:8787/flow/order-paid", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Arcovia-Flow-Secret": secret
  },
  body: JSON.stringify({
    order_id: "dry-run-1001",
    order_name: "#1001",
    email: "",
    customer_name: "Test Customer",
    line_items: [
      {
        title: "Arcovia Sourcing Search Deposit",
        sku: "ARC-DEPOSIT-250"
      }
    ]
  })
});

console.log(response.status);
console.log(await response.text());

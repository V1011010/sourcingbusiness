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
    email: "customer@example.com",
    customer_name: "Test Customer",
    product_request: "Find a trustworthy supplier for Nike Air Jordan 4, men's UK 9, black/red, max budget R3500, delivery to Johannesburg within 2 weeks.",
    line_items: [
      {
        title: "Product Sourcing Deposit",
        sku: "ARC-SOURCE-250"
      }
    ]
  })
});

console.log(response.status);
console.log(await response.text());

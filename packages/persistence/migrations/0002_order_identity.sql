-- Binance orderId identifies an order on a symbol, not across the account.
-- Preserve existing orders while allowing equal exchange IDs on other symbols.
DROP INDEX orders_exchange_order_idx;
CREATE UNIQUE INDEX orders_exchange_order_idx
  ON orders (account_id, symbol, exchange_order_id) WHERE exchange_order_id IS NOT NULL;

// @virtual-path: src/portal/routes-leak-coinbase.ts
export const secret = process.env.COINBASE_CLIENT_SECRET;
export const key = process.env.COINBASE_GRANT_KEY;
export const url = "https://api.coinbase.com/v2/accounts";

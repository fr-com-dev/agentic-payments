// @virtual-path: src/portal/routes-leak.ts
import { tokenFor } from "../shared/config.js";
import { AdminClient } from "./admin-client.js";
export const client = new AdminClient("http://127.0.0.1:4020", tokenFor("portal-admin"));
export const name = "PORTAL_ADMIN_TOKEN";
